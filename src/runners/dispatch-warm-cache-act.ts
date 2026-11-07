/**
 * CARRIES OUT `planWarmFleet`'S PER-NODE DECISION — mint, evict-then-mint
 * (rotate), or leave the slot alone (idle/keep/locked), plus the
 * workload-gate rotation `planWarmFleet` never decides (it has no label
 * model). Split out of `dispatch-warm-cache.ts` (wave shrink-1 lane B,
 * 800-line ceiling): one function per node, called from that file's own
 * `Promise.all`.
 */
import { logger } from '../host.js';
import { unitMemoryMaxMb } from '../lib/job-reserve.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { evictWarmListener, mintWarmListener } from './ephemeral-exec.js';
import { type GhLike } from '../lib/fleet-vocabulary.js';
import { offerFor, shellOnNode, type EphemeralTickInput } from './ephemeral-shared.js';
import { nodeHome } from '../lib/node-users.js';
import { workloadGatedCapabilities } from '../lib/workload-gate.js';
import type { WorkloadGateContext } from '../lib/workload-gate.js';
import { warmBackoffActive, recordWarmFailure, clearWarmFailures } from './warm-backoff.js';
import { checkMintSlice } from './dispatch-warm-cache-state.js';
import type { WarmCacheDecision } from './ephemeral-warm.js';
import type { HostPace } from './speed-tier.js';
import type { ObservedWarmNode, WarmCacheResult } from './dispatch-warm-cache-state.js';

/**
 * Acts on one node's `planWarmFleet` decision. Never throws — caught here,
 * same as the observe pass's own per-node try/catch.
 */
export async function actOnWarmNode(args: {
	observed: ObservedWarmNode;
	decision: WarmCacheDecision;
	neverWarm: ReadonlyMap<string, string>;
	warmExcluded: (
		node: string,
		m: { excludeRepos?: Record<string, string> },
		repo: string
	) => string | undefined;
	input: EphemeralTickInput;
	workloadGate: WorkloadGateContext;
	token: string;
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> };
	sh: typeof shellOnNode;
	tarballUrl: () => Promise<string | null>;
	hostPaceFor?: (node: string) => HostPace | null;
	nowMs: number;
	result: WarmCacheResult;
}): Promise<void> {
	const {
		observed,
		decision,
		neverWarm,
		warmExcluded,
		input,
		workloadGate,
		token,
		gh,
		sh,
		tarballUrl,
		hostPaceFor,
		nowMs,
		result,
	} = args;
	const { node, m, installedMb, current } = observed;
	if (neverWarm.has(node)) return;
	try {
		// #82, THE OTHER HALF: `planWarmFleet` is told each node's exclusions
		// (fleet-manager#36) and should never propose FILLING or ROTATING a
		// node onto one. Checked again here, before any mint, so a slip in the
		// allocator is a withheld fill rather than a listener on a node that
		// must not hold that repo.
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
					hostPace: hostPaceFor?.(node) ?? null,
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
}
