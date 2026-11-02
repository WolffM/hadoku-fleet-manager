/**
 * runner-identity-warm-recheck — a warm registration whose unit the first
 * snapshot did not see, resolved with a second look rather than judged
 * straight off.
 *
 * Moved out of `reconcile-runner-identity.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * A warm registration whose unit the snapshot did not see is either an orphan
 * or a listener that changed while the sweep ran. The warm cache rotates on a
 * 60s tick, so the second case is ordinary, and the snapshot alone cannot tell
 * them apart. So the NAMED node is probed again and the registration re-read:
 *
 *   - unit active now           -> minted after the snapshot; live.
 *   - registration gone now     -> evicted after the snapshot; nothing to judge.
 *   - still registered, no unit -> a WARM ORPHAN, and it FAILS, online or not.
 *
 * It fails offline too, unlike a JIT orphan. A JIT orphan is routine because
 * `reapJitRunners` sweeps every `jit-` name; the warm reap
 * (`reapDeadWarmListener`) only reaches a name the node's marker still holds,
 * and a RESET=1 mint overwrites the marker — #61's leak. Nothing is guaranteed
 * to clear one, so one that survives two looks is a finding, not leakage.
 *
 * A second look that cannot be taken is "I could not look": the suspect stays
 * an orphan, carrying why, rather than being waved through.
 */

import { readRunners, activeWarmUnits } from './runner-identity-reads.mjs';

/**
 * @param {{warmSuspects: object[], nodes: string[],
 *   probeNode: (machine: string) => Promise<{ok: boolean, out?: string, error?: string}>}} args
 */
export async function recheckWarmSuspects({ warmSuspects, nodes, probeNode }) {
	const warmOrphans = [];
	/** Unbacked in the snapshot, resolved by the second look — printed so a rotation is visible. */
	const warmRechecked = [];
	const suspectsByNode = new Map();
	for (const s of warmSuspects) {
		if (!suspectsByNode.has(s.node)) suspectsByNode.set(s.node, []);
		suspectsByNode.get(s.node).push(s);
	}
	const relisted = new Map();
	for (const [node, suspects] of suspectsByNode) {
		if (!nodes.includes(node)) {
			for (const s of suspects)
				warmOrphans.push({ ...s, why: 'names no manifest node, so no unit can back it' });
			continue;
		}
		const again = await probeNode(node);
		const live = again.ok ? activeWarmUnits(again.out) : null;
		for (const s of suspects) {
			if (!live) {
				warmOrphans.push({ ...s, why: `second look at ${node} failed: ${again.error}` });
				continue;
			}
			if (live.has(`${s.name}.service`)) {
				warmRechecked.push({ ...s, outcome: 'unit active on second look' });
				continue;
			}
			if (!relisted.has(s.repo)) relisted.set(s.repo, await readRunners(s.repo));
			const listing = relisted.get(s.repo);
			if (!listing.ok) {
				warmOrphans.push({
					...s,
					why: `no unit on ${node}; re-reading the registration failed: ${listing.reason}`,
				});
				continue;
			}
			const still = listing.runners.find((x) => x.id === s.id);
			if (!still) {
				warmRechecked.push({ ...s, outcome: 'registration removed since the listing' });
				continue;
			}
			warmOrphans.push({
				...s,
				status: still.status,
				why: `no active unit on ${node} on either look`,
			});
		}
	}
	return { warmOrphans, warmRechecked };
}
