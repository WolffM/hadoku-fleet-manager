import { isDraining, readDrain } from './drain.js';
import { effectiveHosting, readHostingDoc } from './hosting-record.js';
import {
	DEFAULT_RUNNER_SLICE,
	planWarmFleet,
	resolveSliceName,
	spaceRefusal,
	unitMemoryMaxMb,
	warmCacheEligible,
	warmListenerSlots,
	warmRunnerName,
	warmSlotLocked,
	type WarmFleetNode,
	type WarmServedJob,
	type WarmSlotState,
} from './ephemeral.js';
import {
	evictWarmListener,
	withholdWarmListener,
	warmRegistration,
	readWarmMarker,
	mintWarmListener,
	refreshWarmMarker,
	runnerTarballUrl,
	type GhLike,
} from './ephemeral-exec.js';
import { heavyMarkedRecently } from './dispatch-pass.js';
import { slowReposOn } from './placement.js';
import { recordWarmListenerDecisions, type WarmListenerDecision } from './decision-log.js';
import { nodeHome } from '../lib/node-users.js';
import { workloadGatedCapabilities } from '../capabilities.js';
import { jobRecords } from '../job-history.js';
import { logger } from '../host.js';
import {
	withoutGuests,
	offerFor,
	loadWorkloadGateContext,
	jobReserve,
	shellOnNode,
	SPACE_PROBE_DF_CMD,
	parseSpaceProbe,
	type EphemeralTickInput,
} from './ephemeral-shared.js';
import { getSpeedModel, getHeavyModel } from './speed-heavy-cache.js';
import {
	WARM_CACHE_INTERVAL_MS,
	warmBackoffActive,
	recordWarmFailure,
	clearWarmFailures,
} from './warm-backoff.js';

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

let lastWarmCacheMs = 0;

/** Test seam. Not part of the supported API. */
export function __resetWarmCacheClockForTesting(): void {
	lastWarmCacheMs = 0;
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
 * override, and as a guest it never holds a listener).
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
async function reapDeadWarmListener(
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
function setWarmRepos(next: ReadonlyMap<string, string>): void {
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

const EMPTY_WARM_RESULT: WarmCacheResult = {
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
type ObservedWarmSlot = WarmSlotState & { labels: string[] | null };

interface ObservedWarmNode {
	node: string;
	m: EphemeralTickInput['nodes'][string];
	installedMb: number;
	current: ObservedWarmSlot | null;
	/** #101: this pass's OWN measurement, not borrowed from the dispatch
	 *  tick's verdict — see the probe below and `spaceRefusal`. */
	tmpFreeMb: number | null;
	workFreeMb: number | null;
}

/**
 * Maintain the warm cache of one, for every eligible ephemeral node.
 *
 * INDEPENDENT of the JIT mint pass in `dispatchEphemeral`, on its own clock —
 * see WARM_CACHE_INTERVAL_MS. Eligibility, the lock and the fill/rotate
 * decision are all pure (see ephemeral.ts); this function only does the I/O
 * the decision calls for, exactly the split `mintEphemeralRunner` and
 * `admitMint` already keep.
 *
 * NEVER THROWS. A node's warm-cache maintenance failing must not stop
 * another node's, and must not stop the JIT mint pass this runs alongside —
 * every per-node step below is caught and counted as `failed` rather than
 * propagated.
 */
export async function dispatchWarmCache(
	tickInput: EphemeralTickInput,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: typeof shellOnNode = shellOnNode,
	nowMs: number = Date.now()
): Promise<WarmCacheResult> {
	// THE KILL SWITCH. issue #7's clause (a): a way to stop this without a
	// redeploy. Checked before the tick's own clock so it also holds off
	// `lastWarmCacheMs`, which is deliberate — a disabled cache should not
	// consume the first eligible tick once re-enabled either.
	if (process.env.WARM_CACHE_DISABLED === '1') {
		// The kill switch takes the AFFINITY half with it. With maintenance off,
		// nothing re-confirms a slot against GitHub, and a remembered map would go
		// on steering placement toward listeners nobody is checking are still
		// there — a belief with no reader, which is the shape this whole
		// workstream keeps paying for. Placement falls through to plain ordering,
		// which is what the fleet did before P5.1 existed.
		setWarmRepos(new Map());
		return { ...EMPTY_WARM_RESULT };
	}
	const input = withoutGuests(tickInput);
	if (!input.ephemeral.size) return { ...EMPTY_WARM_RESULT };
	if (nowMs - lastWarmCacheMs < WARM_CACHE_INTERVAL_MS) return { ...EMPTY_WARM_RESULT };
	lastWarmCacheMs = nowMs;
	// ONE state-dir read for this whole tick — see `offerFor`'s own doc.
	const workloadGate = loadWorkloadGateContext(Object.keys(input.nodes));

	const result: WarmCacheResult = { ...EMPTY_WARM_RESULT };
	/**
	 * This pass's observation, published wholesale at the end.
	 *
	 * Built fresh rather than mutated in place, so a node that went drained,
	 * unreachable, ineligible or listener-less between ticks simply does not
	 * appear — there is no path here that can leave a stale entry behind.
	 */
	const observedWarm = new Map<string, string>();

	/**
	 * Where a node with NO runner payload at all may fetch a release.
	 *
	 * This was hard-coded `null` until 2026-09-08, which meant the fallback
	 * `warm-provision.sh` documents was, in production, never once taken —
	 * `RUNNER_TARBALL_URL` had exactly one caller and it was the JIT half.
	 * That is only half of why claw-1/3/5 could not fill (the script also
	 * needed a runner ROOT it could not build; it now registers straight
	 * through `$PAYLOAD/bin/Runner.Listener` and needs no root at all), but a
	 * hard-coded null is still a fallback that cannot fire, so it goes.
	 *
	 * RESOLVED LAZILY, and that matters for the API budget. `runnerTarballUrl`
	 * memoises for a day, so the steady-state cost is one call per day — but
	 * only if something asks. Calling it unconditionally at the top of the
	 * tick would spend that call on every tick of a fleet where no node has
	 * ever needed it, and this tick's whole cadence design (see
	 * WARM_CACHE_INTERVAL_MS) is about not doing that.
	 */
	let tarballPromise: Promise<string | null> | null = null;
	const tarballUrl = (): Promise<string | null> =>
		(tarballPromise ??= runnerTarballUrl(gh.get, token, input.repos[0] ?? ''));
	// Read ONCE per tick, same as dispatchEphemeral's own drainedNodes below —
	// a drain is operator state on disk, and re-reading it per node would let a
	// node change status mid-pass.
	const drainState = readDrain();
	// Shared hosting slices, read once with it. Unreadable THROWS, as the drain
	// does: a tick that cannot tell what a tenant was promised mints nothing.
	const sharedHosting = effectiveHosting(readHostingDoc());

	const observed = (
		await Promise.all(
			[...input.ephemeral].map(async (node): Promise<ObservedWarmNode | null> => {
				try {
					const m = input.nodes[node];
					const p = input.fleetProbe.get(node);
					if (!m || !p?.reachable) return null;

					// issue #7 clause (b), the eligibility half: MEASURED installed
					// capacity, never `mintBudget`'s job-concurrency cap AS THE MEMORY
					// FIGURE — see warmEligibleSlots for why feeding it maxConcurrent
					// was the bug that put a warm listener on claw-2's single
					// 4GB-class slot. The cap is a SECOND, independent condition
					// (`warmConcurrencySlots`, folded into `warmListenerSlots` below),
					// not a substitute for the first: one asks whether the box has the
					// memory, the other whether its ceiling has the slot.
					// Read live, the same shape of call dispatchEphemeral already makes
					// for available memory, just the TOTAL column instead of the
					// available one — this is INSTALLED capacity, which does not move
					// tick to tick, but the manifest's ramGb is display-only and must
					// never be gated on (fleet-runner-manifest.json's own
					// $why-display-only note).
					const totalOut = await sh(
						node,
						"free -m | awk '/^Mem:/{print $2}'; " + SPACE_PROBE_DF_CMD
					);
					const { first, tmpFreeMb, workFreeMb } = parseSpaceProbe(totalOut);
					// A SHARED HOSTING SLICE is not CI's to count on: installed memory
					// includes it, so the whole declaration comes off what a listener
					// may plan around (src/runners/hosting-record.ts).
					const hostedMb = sharedHosting[node]?.memoryMb ?? 0;
					const installedMb = Number(first);
					if (!Number.isFinite(installedMb) || installedMb <= 0) {
						logger.warn(
							`[warm-cache] ${node}: could not read installed memory — not eligible this tick`
						);
						return null;
					}
					// #101: this pass's OWN measurement — see `ObservedWarmNode`'s
					// docblock for why the pre-pass below must not borrow
					// `dispatchEphemeral`'s verdict instead.
					const minFreeMb = m.minFreeMb ?? 1536;
					// THE SAME CALL dispatchEphemeral makes to decide how many slots of
					// this node's cap to hold BACK for the listener this may place —
					// same `usableMb`, same `jobMb`, same tick. See warmListenerSlots:
					// if the two ever disagreed, the node would carry a listener nobody
					// reserved for, which is the 48 four-concurrent starts on claw-3.
					const slots = warmListenerSlots({
						usableMb: installedMb - minFreeMb - hostedMb,
						role: m.role,
						maxConcurrent: m.maxConcurrent,
						// A MINT's worth — the same figure admission reserves below for a
						// job whose repo it cannot name.
						jobMb: jobReserve({
							nodeJobP95Mb: m.jobP95Mb,
							capMb: unitMemoryMaxMb({
								requestedMb: m.slice?.unitMaxMb,
								sliceCeilingMb: installedMb - minFreeMb,
							}),
						}).mb,
					});
					if (!warmCacheEligible(slots)) return null;

					const marker = await readWarmMarker(node, sh);
					// #61. A marker whose unit systemd positively reports dead is a
					// registration this tick is about to walk away from: the planner
					// below sees `current: null` and FILLS, and the fill's `RESET=1`
					// overwrites the marker with a different repo. Deleting it here —
					// before the plan, so the act pass cannot mint over the evidence —
					// is the only place in the fleet that holds the dead repo's name.
					if (marker?.active === false) {
						if (await reapDeadWarmListener(node, marker.repo, marker.unit, token, gh, sh)) {
							result.reaped++;
						}
					}
					const slot = marker?.active === true ? marker : null;
					let current: ObservedWarmSlot | null = null;
					if (slot) {
						const reg = await warmRegistration(slot.repo, slot.unit, token, gh);
						const busy = reg ? reg.busy : null;
						if (busy) await refreshWarmMarker(node, sh);
						// P5.1'S PLACEMENT INPUT, AND THE ONLY SOURCE IT IS ALLOWED TO
						// HAVE. Three independent facts must agree before this node is
						// preferred for this repo: the marker names it (the node's own
						// record), systemd reports the unit ACTIVE (`currentWarmSlot` —
						// the kernel, not our bookkeeping), and GitHub's listing reports
						// the registration ONLINE. Issue #17 is precisely the case where
						// the first holds and the third does not.
						//
						// NOT SET BY THE FILL OR ROTATE BELOW, deliberately. A mint that
						// has just returned has not appeared in GitHub's listing yet, and
						// recording it here would be this file believing its own write —
						// the exact failure it exists to guard against. The next tick's
						// listing confirms it 60 s later, which costs at most four
						// dispatch cycles of missed affinity and cannot manufacture a
						// false one.
						if (reg?.online) observedWarm.set(node, slot.repo);
						current = {
							repo: slot.repo,
							// `null` (could not confirm) fails toward LOCKED — the same
							// direction every other "I could not look" in this workstream
							// takes. A slot we cannot vouch for is not safe to evict.
							busy: busy ?? true,
							mintedOrRefreshedAtMs: busy ? nowMs : slot.markerAtMs,
							// `null` here (reg unreadable) must NOT be read as "carries no
							// gated label" — the workload-gate rotate check below treats a
							// null the same way it treats `null` busy: cannot vouch for it,
							// so it must not churn the slot on a guess.
							labels: reg ? reg.labels : null,
						};
					}

					return { node, m, installedMb, current, tmpFreeMb, workFreeMb };
				} catch (err) {
					result.failed++;
					logger.warn(`[warm-cache] ${node}: ${err instanceof Error ? err.message : String(err)}`);
					return null;
				}
			})
		)
	).filter((o): o is ObservedWarmNode => o !== null);

	// WAVE 3W (#82, #83): THE WARM PATH IS A SECOND ASSIGNMENT PATH.
	// A warm listener is a STANDING registration GitHub hands work to
	// DIRECTLY — `choosePlacement` never sees it, and neither #82's per-repo
	// exclusion nor #83's slow-tier spill gate reaches here on its own. Found
	// live (send-back on this wave): `~/.hadoku-mgmt/job-history.jsonl` shows
	// claw-5 served 23 hadoku-cardtable jobs and 164 hadoku_site jobs through
	// `warm-claw-5-*` listeners while it was excluded from JIT only.
	//
	// THE SAME CACHED MODEL the mint tick uses, not a second build — see
	// `getSpeedModel`'s own module-level cache; calling it twice in one
	// process just returns the SAME object inside its 10-minute window.
	const speedModel = getSpeedModel(nowMs, Object.keys(input.nodes));
	// THE SAME CACHED HEAVY MODEL, same reason (#102) — see `getHeavyModel`'s
	// own cadence note.
	const heavyModel = getHeavyModel(nowMs);

	// A node fully excluded from the joint allocation below (slow tier: it
	// must never be GIVEN a slot, not merely told to give one back) is also
	// excluded from the act loop after this — there is nothing for `decisions`
	// to say about it, and reading that absence as `idle` would count a
	// deliberate, permanent hold-back as an ordinary quiet tick.
	const neverWarm = new Map<string, string>();
	const planNodes: WarmFleetNode[] = [];
	// The repos a node must not hold a listener for: the manifest's
	// `excludeRepos` (#82), then any repo with a kind this node runs slowly
	// (#8, `slowReposOn`). Both check points below read this, never one alone.
	const slowRepos = new Map(observed.map((o) => [o.node, slowReposOn(speedModel, o.node)]));
	const warmExcluded = (
		node: string,
		m: { excludeRepos?: Record<string, string> },
		repo: string
	): string | undefined => {
		const manifest = (m.excludeRepos ?? {})[repo];
		if (manifest !== undefined) return `repo excluded here: ${manifest} (#82)`;
		const slow = slowRepos.get(node)?.get(repo);
		return slow !== undefined ? `${slow} (#8)` : undefined;
	};
	for (const o of observed) {
		const tier = speedModel.tierOf(o.node);
		// THE THIRD ENFORCEMENT POINT (#90, drain-node.mjs's header). A warm
		// listener is neither of the first two (placement never sees it; it is
		// not `hadoku-builder` on a standing registration either) — GitHub
		// assigns straight to it. Folded into the SAME exclude-and-evict branch
		// the slow tier already uses (#83) rather than a second one: both are
		// "this node must hold nothing, and whatever it already holds gets
		// evicted on the next pass, respecting the same busy/assign-window
		// lock". A node drained mid-pass (either `kind`) reads the same
		// `drainState` `dispatchEphemeral` already read once this tick.
		const drained = isDraining(o.node, drainState);
		// #101: THIS PASS'S OWN MEASUREMENT (`o.tmpFreeMb`/`o.workFreeMb`,
		// read by the probe above), not `dispatchEphemeral`'s verdict.
		// Borrowing that verdict had two real holes: (a) MASKING —
		// `admitMint` returns the FIRST refusing clause, so a node that is
		// ALSO at capacity or memory-refused reports `concurrency`/`memory`
		// and would keep its warm listener while out of `/tmp` — exactly the
		// busy-and-full #101 state; (b) right after a process restart there
		// is no verdict at all yet, and a node this check has no opinion on
		// is not the same as a node confirmed to have space — the warm pass
		// could FILL an unmeasured node. Asking `spaceRefusal` directly from
		// this pass's own probe closes both: it never masks (no other
		// clause can suppress it) and it is never missing for a node this
		// loop actually reached (the probe above always sets both fields,
		// `null` on an unreadable `df`, never `undefined`).
		const space = spaceRefusal({ tmpFreeMb: o.tmpFreeMb, workFreeMb: o.workFreeMb });
		const spaceRefused = space !== null;
		// #102.4: "a node running a heavy job is not a place to (re)fill a warm
		// listener" — a warm listener hands work with ZERO queue wait, which is
		// exactly as bad an idea on a node ALREADY crunching a heavy job as it is
		// on a slow one (the `tier === 'slow'` clause just above). REPO-LEVEL
		// ONLY — see `HeavyModel.isHeavyRepo`'s own doc for the approximation
		// this rests on, the same one `dispatchEphemeral`'s `NodeState.runningHeavy`
		// uses.
		const runningHeavyNow =
			[...(input.fleetProbe.get(o.node)?.busyRepos ?? [])].some(
				([repo, n]) => n > 0 && heavyModel.isHeavyRepo(repo)
			) ||
			// The dispatcher's own, fresher word (#102): it placed or saw a heavy
			// job here within the last HEAVY_MARK_MS, which the probe may not show
			// yet — without this the tick refills the listener the pass evicted.
			heavyMarkedRecently(o.node, nowMs);
		// EVERY NODE'S PRE-PASS WORK IS ITS OWN TRY/CATCH, same reason the act
		// loop below already wraps each node: `evictWarmListener` awaits `sh`
		// and a GitHub delete, either of which can throw. Before this, ONE
		// node's throw rejected the whole pass — no other node's fill or
		// rotate ran, `setWarmRepos` never published, and it would have kept
		// throwing every WARM_CACHE_INTERVAL_MS tick forever. Caught per node,
		// exactly like the act loop already treats a per-node failure: count
		// it, say why with the node and the real error, move on.
		try {
			if (tier === 'slow' || drained || spaceRefused || runningHeavyNow) {
				neverWarm.set(
					o.node,
					tier === 'slow'
						? 'slow tier'
						: drained
							? 'drained'
							: spaceRefused
								? (space?.reason ?? 'space refusal')
								: 'running a heavy-kind job'
				);
				// A DRAIN MAY NOT WAIT FOR AN IDLE MOMENT. The eviction below is locked
				// while the listener is busy, and a listener under load is busy at
				// nearly every look — see `withholdWarmListener`. Withholding first
				// stops new assignments at once; the eviction follows when it idles.
				// Drain only: the other three reasons are about where work SHOULD go,
				// and a job finishing on a slow node is not a safety question.
				if (drained && o.current) {
					const w = await withholdWarmListener(
						o.current.repo,
						warmRunnerName(o.node, o.current.repo),
						token,
						gh
					);
					if (w === 'failed') result.failed++;
				}
				if (
					o.current &&
					!warmBackoffActive(o.node, nowMs) &&
					!warmSlotLocked({
						busy: o.current.busy,
						mintedOrRefreshedAtMs: o.current.mintedOrRefreshedAtMs,
						nowMs,
					})
				) {
					const reason = drained
						? `drained (#90): a warm listener is a standing registration GitHub assigns ` +
							'to directly, which neither of the other two enforcement points reaches'
						: spaceRefused
							? (space?.reason ?? 'space refusal')
							: tier === 'slow'
								? `slow tier never holds one (p25 ${speedModel.describe(o.node).p25 ?? 'null'}, #83): ` +
									'a warm listener takes work with ZERO queue wait, which is exactly what the ' +
									'spill gate exists to forbid'
								: 'running a heavy-kind job (#102.4): a warm listener takes work with ZERO ' +
									'queue wait, which is exactly what stacking onto a heavy job must not do';
					logger.info(
						`[warm-cache] ${o.node}: evicting its warm listener for ${o.current.repo} — ${reason}`
					);
					const evicted = await evictWarmListener(
						o.node,
						o.current.repo,
						warmRunnerName(o.node, o.current.repo),
						token,
						gh,
						sh
					);
					if (evicted) result.evicted++;
					else {
						result.failed++;
						logger.warn(
							`[warm-cache] could not evict ${drained ? 'drained' : spaceRefused ? 'space-refused' : tier === 'slow' ? 'slow-tier' : 'heavy-busy'} ${o.node}'s warm slot for ${o.current.repo}`
						);
					}
				}
				// Excluded from `planNodes` regardless of whether an eviction ran
				// this tick (busy, backed off, or just failed) — the point is that
				// `planWarmFleet` must never be offered this node to FILL, not only
				// that a live listener gets removed. This is also why a drained
				// node is never RE-FILLED while drained: it never reaches
				// `planNodes` to be offered a slot in the first place.
				continue;
			}
			// #82: THE CURRENT repo is one THIS node refuses. Evict it (respecting
			// the same busy/assign-window lock `planWarmFleet`'s own `rotate`
			// decision already respects, and the same backoff every other eviction
			// here does) and offer the node up with `current: null` — it still
			// competes for a DIFFERENT, allowed repo below, exactly like a node
			// whose listener was just found dead by the reap check above.
			const excludedReason = o.current ? warmExcluded(o.node, o.m, o.current.repo) : undefined;
			if (
				o.current &&
				excludedReason !== undefined &&
				!warmBackoffActive(o.node, nowMs) &&
				!warmSlotLocked({
					busy: o.current.busy,
					mintedOrRefreshedAtMs: o.current.mintedOrRefreshedAtMs,
					nowMs,
				})
			) {
				logger.info(
					`[warm-cache] ${o.node}: evicting its warm listener for ${o.current.repo} — ${excludedReason}`
				);
				const evicted = await evictWarmListener(
					o.node,
					o.current.repo,
					warmRunnerName(o.node, o.current.repo),
					token,
					gh,
					sh
				);
				if (evicted) {
					result.evicted++;
					planNodes.push({ node: o.node, current: null });
					continue;
				}
				result.failed++;
				logger.warn(
					`[warm-cache] could not evict ${o.node}'s excluded warm slot for ${o.current.repo}`
				);
			}
			planNodes.push({ node: o.node, current: o.current });
		} catch (err) {
			result.failed++;
			const excludedForTick = tier === 'slow' || drained || runningHeavyNow;
			logger.warn(
				`[warm-cache] ${o.node}: pre-pass failed (${tier} tier${drained ? ', drained' : ''}${runningHeavyNow ? ', running heavy' : ''}), ` +
					`${excludedForTick ? 'leaving it excluded from this tick' : 'passing it through with its current slot unchanged'}: ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
			// Same rule the slow-tier/drained/heavy-busy branch already enforces on
			// success: never let an excluded node reach `planNodes`, thrown or not.
			// A node that failed mid-eviction for none of those reasons is passed
			// through UNCHANGED — today's behaviour before this wave, for the same
			// reason the eviction-failed branch above already does it on a clean
			// `false` rather than a throw: an eviction we could not confirm is not
			// safe to assume.
			if (!excludedForTick) planNodes.push({ node: o.node, current: o.current });
		}
	}

	// THE JOINT ALLOCATION (wave 3k §B). Every eligible node's slot is decided
	// at once, over the fleet's history, so the Nth node takes the Nth most
	// valuable UNCOVERED repo — a per-node argmax put hadoku_site on all four.
	// `planNodes`, not `observed`, is what is handed over (#82, #83 above):
	// `planWarmFleet` is pure and knows nothing of exclusions or speed, so the
	// node list it is given IS the eligibility it can ever honour.
	const decisions = planWarmFleet({
		nodes: planNodes,
		served: fleetServedJobs(),
		nowMs,
	});
	// THE DECISION LOG (T1): each node's slot decision, as the act loop below
	// will read it — the warm path's placement, which `planTick` never sees.
	// Written only when a node's decision changes; never throws.
	recordWarmListenerDecisions(
		() =>
			observed.map((o): WarmListenerDecision => {
				const never = neverWarm.get(o.node);
				const held = o.current?.repo ?? null;
				if (never !== undefined) {
					return { node: o.node, action: 'never-warm', repo: held, reason: never };
				}
				const d = decisions.get(o.node) ?? { action: 'idle' };
				const target = d.action === 'fill' ? d.repo : d.action === 'rotate' ? d.to : null;
				const withheld = target !== null ? warmExcluded(o.node, o.m, target) : undefined;
				if (withheld !== undefined) {
					return { node: o.node, action: 'withheld', repo: target, reason: withheld };
				}
				return {
					node: o.node,
					action: d.action,
					repo: target ?? held,
					from: d.action === 'rotate' ? d.from : null,
					reason: null,
				};
			}),
		nowMs
	);

	await Promise.all(
		observed.map(async ({ node, m, installedMb, current }) => {
			if (neverWarm.has(node)) return;
			try {
				const decision = decisions.get(node) ?? { action: 'idle' };
				// #82, THE OTHER HALF: `planWarmFleet` ranks repos by served history
				// alone and can still propose FILLING or ROTATING a node onto a repo
				// that node excludes — it was never told. Caught here, before any
				// mint, rather than trusted to the pre-pass above, which only knows
				// about the repo a node ALREADY holds.
				//
				// COUNTED AS `locked`, not a new field on `WarmCacheResult`: both mean
				// "the allocator wanted to change this slot and something outside its
				// own model said no" — a busy/assign-window lock for `locked`'s usual
				// case, a manifest exclusion for this one. A dedicated counter was
				// tried and reverted: `WarmCacheResult` is asserted by exact shape
				// (`assert.deepEqual`) in a dozen-plus existing tests this lane does
				// not own, and even a strictly additive field broke a chain of them —
				// one assertion without a try/finally around its own
				// `WARM_CACHE_DISABLED` mutation threw before restoring it, which left
				// the kill switch ON for every test after it in the same process.
				const target =
					decision.action === 'fill'
						? decision.repo
						: decision.action === 'rotate'
							? decision.to
							: null;
				if (target !== null) {
					const reason = warmExcluded(node, m, target);
					if (reason !== undefined) {
						result.locked++;
						logger.info(
							`[warm-cache] ${node}: withholding a ${decision.action} onto ${target} — ${reason}`
						);
						return;
					}
				}
				// THE SLICE CEILING for this node, from the SAME measured total the
				// eligibility check above already read — `installedMb` is `free -m`'s
				// `$2`, and `minFreeMb` is the floor that keeps the claw alive. A warm
				// listener serves the same jobs a JIT unit does, so capping it lower
				// would reintroduce #26 on exactly the path the cache exists to make
				// faster.
				const memoryMaxMb = unitMemoryMaxMb({
					requestedMb: m.slice?.unitMaxMb,
					sliceCeilingMb: installedMb - (m.minFreeMb ?? 1536),
				});
				// The warm half of the containment assertion. A warm listener sits in
				// its slice for HOURS rather than for one job, so a node whose declared
				// slice the minter cannot honour is worth saying out loud here too.
				checkMintSlice(input.nodes, node);
				const mintFor = async (repo: string) =>
					mintWarmListener(
						{
							node,
							repo,
							runnerName: warmRunnerName(node, repo),
							// DERIVED, not declared — see `offerFor`. `warmLabels` subtracts
							// the ephemeral-only ones on top of this, because a warm listener
							// is STANDING and must never be able to answer the canary.
							labels: offerFor(input.nodes, node, workloadGate),
							homeDir: nodeHome(input.nodes[node], 'ci'),
							memoryMaxMb,
							tarballUrl: await tarballUrl(),
						},
						token,
						gh,
						sh
					);

				switch (decision.action) {
					case 'idle':
					case 'keep': {
						// WORKLOAD-GATE ROTATION (wave 4e follow-up, #102). A slot
						// `planWarmFleet` is content to KEEP can still be carrying a
						// WORKLOAD-GATED label `offerFor` no longer offers this node —
						// claw-3's own shape, if claw-3 holds a warm listener for
						// cardtable: its jdk21 FAILS, placement and the JIT mint both
						// stop offering it from that tick on, but this already-registered
						// listener answers `jdk21` to GitHub until something else evicts
						// it. Only a GATED label triggers this — any other label drift
						// is out of scope for this wave and must not start churning
						// slots on its own.
						//
						// NO NEW API CALL: `current.labels` is read off the SAME
						// `/actions/runners` listing `warmRegistration` already fetched
						// for the busy/online check above. `null` means that listing
						// could not confirm the registration's labels (same reason
						// `busy` would be `null`) — "could not look" must not churn a
						// slot on a guess, so it is treated exactly like "nothing stale
						// found": kept, not rotated.
						const stale = current?.labels
							? workloadGatedCapabilities().find(
									(id) =>
										current.labels!.includes(id) &&
										!offerFor(input.nodes, node, workloadGate).includes(id)
								)
							: undefined;
						// BUSY IS NEVER ROTATED (same rule `locked`/the eviction passes
						// above already enforce): a listener running a job is not killed
						// mid-job. `current.busy` already fails toward `true` ("could not
						// confirm" — see its own assignment above), so an unreadable
						// registration is treated as busy here too, which is the same
						// safe direction.
						if (!stale || !current || current.busy) {
							result.kept++;
							return;
						}
						if (warmBackoffActive(node, nowMs)) {
							result.kept++;
							return;
						}
						logger.info(
							`[warm-cache] ${node}: rotating ${current.repo} — workload-gate: ` +
								`offerFor no longer offers "${stale}" for this node, which the ` +
								`existing registration still advertises to GitHub`
						);
						const evicted = await evictWarmListener(
							node,
							current.repo,
							warmRunnerName(node, current.repo),
							token,
							gh,
							sh
						);
						if (!evicted) {
							result.failed++;
							logger.warn(
								`[warm-cache] could not evict ${current.repo} warm slot on ${node} for a workload-gate relabel`
							);
							return;
						}
						result.evicted++;
						const outcome = await mintFor(current.repo);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.rotated++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] workload-gate rotate failed on ${node} for ${current.repo}: ${outcome.reason}`
							);
						}
						return;
					}
					case 'locked':
						result.locked++;
						return;
					case 'fill': {
						// issue #7 clause (c): backed off, skip SILENTLY. This is the
						// difference between "the log stops repeating every minute"
						// and "the log repeats but nobody pays for it" — a node stuck
						// on a real fault (e.g. the runner root is unreachable) must
						// not cost a registration-token call and a heavy provisioning
						// ssh every single tick.
						if (warmBackoffActive(node, nowMs)) return;
						const outcome = await mintFor(decision.repo);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.filled++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] fill failed on ${node} for ${decision.repo}: ${outcome.reason}`
							);
						}
						return;
					}
					case 'rotate': {
						if (warmBackoffActive(node, nowMs)) return;
						const evicted = await evictWarmListener(
							node,
							decision.from,
							warmRunnerName(node, decision.from),
							token,
							gh,
							sh
						);
						if (!evicted) {
							result.failed++;
							logger.warn(`[warm-cache] could not evict ${decision.from} warm slot on ${node}`);
							return;
						}
						result.evicted++;
						const outcome = await mintFor(decision.to);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.rotated++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] rotate failed on ${node} for ${decision.to}: ${outcome.reason}`
							);
						}
						return;
					}
				}
			} catch (err) {
				result.failed++;
				logger.warn(`[warm-cache] ${node}: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);

	// PUBLISHED AFTER EVERY NODE HAS BEEN WALKED, never incrementally: the map is
	// a statement about the whole fleet at one instant, and a half-built one read
	// mid-pass would say "no node is warm for this repo" about a node the pass
	// had simply not reached yet.
	setWarmRepos(observedWarm);

	if (result.filled || result.rotated || result.evicted || result.reaped || result.failed) {
		logger.info(
			`[warm-cache] filled=${result.filled} rotated=${result.rotated} kept=${result.kept} ` +
				`locked=${result.locked} evicted=${result.evicted} reaped=${result.reaped} ` +
				`failed=${result.failed}`
		);
	}
	return result;
}
