/**
 * THE WARM HALF OF THE HEAVY HOLD (#102) — evicts a node's idle warm listener
 * the moment it is running a heavy job, since the hold on the JIT mint side
 * does nothing about a standing registration GitHub hands work to without
 * asking. Split out of `dispatch-pass.ts` (wave shrink-1 lane B, 800-line
 * ceiling); `dispatch-pass.ts` re-exports `closeWarmBesideHeavy` under its
 * original path (it was already a private helper there, so nothing else
 * imports it directly).
 */
import { logger } from '../host.js';
import { evictWarmListener, warmRegistration } from './ephemeral-exec.js';
import { type GhLike, type ShellLike } from '../lib/fleet-vocabulary.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import type { NodeState } from './placement-node-state.js';
import { heavyMarkedAtMs, heavyMarkedRecently } from './dispatch-pass-state.js';

/**
 * THE WARM HALF OF THE HEAVY HOLD (#102). The hold refuses a JIT mint beside
 * a heavy job, but a warm listener is a standing registration GitHub hands
 * work to without asking: cardtable run 37857873226 (2026-10-08 23:10Z) had
 * forge-e2e (2) held off claw-8 and claw-9 by `heavy hold`, and claw-4's idle
 * warm listener took it 54 s after claw-4 started forge-e2e (1) — inside the
 * warm tick's 60 s, whose own heavy check reads the probe and had not seen it.
 *
 * So the moment a node is running a heavy job — placed this pass, or a heavy
 * sibling seen in a queued run's listing — its warm listener for a heavy-kind
 * repo goes, if idle. A BUSY one is left alone: stopping it would kill its job.
 * The node is marked so the warm tick does not refill it before the probe
 * catches up ({@link heavyMarkedRecently}). One runner listing per such node,
 * only on the pass that FIRST marks it, so a long shard costs one call, not
 * one every 15 s.
 */
export async function closeWarmBesideHeavy(
	nodes: readonly NodeState[],
	mintedHeavyOn: readonly string[],
	heavyModel: NodeState['heavyModel'],
	nowMs: number,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike
): Promise<void> {
	if (!heavyModel) return;
	const heavyNow = new Set(mintedHeavyOn);
	for (const m of nodes) if ((m.heavyJobs ?? 0) > 0) heavyNow.add(m.name);
	for (const m of nodes) {
		if (!heavyNow.has(m.name)) continue;
		const fresh = !heavyMarkedRecently(m.name, nowMs);
		heavyMarkedAtMs.set(m.name, nowMs);
		if (!fresh || !m.warmRepo || !heavyModel.isHeavyRepo(m.warmRepo)) continue;
		const name = warmRunnerName(m.name, m.warmRepo);
		const reg = await warmRegistration(m.warmRepo, name, token, gh);
		if (!reg || reg.busy) {
			logger.info(
				`[dispatch] ${m.name} is running a heavy job; its warm listener for ${m.warmRepo} is ` +
					`${reg ? 'busy' : 'unreadable'} and stays — the warm tick evicts it once idle`
			);
			continue;
		}
		const evicted = await evictWarmListener(m.name, m.warmRepo, name, token, gh, sh);
		logger.info(
			`[dispatch] ${m.name} is running a heavy job: ${evicted ? 'evicted' : 'could not evict'} ` +
				`its idle warm listener for ${m.warmRepo} (#102)`
		);
	}
}
