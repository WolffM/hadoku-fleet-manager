/**
 * The slow-tier and per-kind spill thresholds — wave 5s lane A split of
 * `placement.ts` (pure move), so that file falls under the 800-line source
 * ceiling.
 *
 * `slowKind`/`slowReposOn` are the ONE definition the mint path
 * (`placement-refusal.ts`'s `refusalFor`) and the warm path (`slowReposOn`'s
 * own callers) both read, per `placement.ts`'s own note on that. `describeKind`
 * is exported, unlike in the original file, only so `placement-refusal.ts`
 * can share it rather than holding a second copy. Every OTHER name here is
 * re-exported from `placement.ts` so its existing importers compile
 * unchanged.
 */
import { SLOW_P25, type KindSlowness, type SpeedModel } from './speed-tier.js';

/**
 * How long a heavy job holds out for a node not already running a heavy job
 * (#102) before taking one that is.
 *
 * Doubling two heavy jobs on one node buys no wall time and costs reds:
 * cardtable run 37851403985 (2026-10-08 22:08Z) put forge-e2e (2), (3) and
 * forge-jvm on claw-4 at once because three jdk21 nodes cannot hold four
 * jdk21 jobs one apiece. Both doubled shards took ~16 min against 7-11 alone
 * on claw-8/9 — about what running them back to back costs — and every
 * spec that failed, 8 of them, was the play server's 20 s match-create POST
 * timing out under CPU starvation. Shard 1, alone on claw-9, was green.
 *
 * 3600 s, raised from 900 on 2026-10-09: under a real backlog the clock, not a
 * freed node, was how holds ended. Eleven verify dispatches queued in ten
 * minutes, every job passed 900 s, and claw-4 took two Forge shards at load 13
 * on 8 cores. Since 2026-11-11 this is the hold off a node already running
 * TWO or more heavy jobs; one running exactly one holds for
 * {@link HEAVY_DOUBLE_HOLD_SEC}. The clock stays so a heavy job never queues
 * forever (#102.4), matching the stuck-run ceiling.
 */
export const HEAVY_HOLD_SEC = 3600;

/**
 * How long a heavy job holds out before DOUBLING onto a node running exactly
 * one heavy job (2026-11-11). A third shard still waits {@link HEAVY_HOLD_SEC}.
 *
 * The single 3600 s hold rested on "a node frees as soon as one shard finishes
 * (~10 min), so waiting is never slower than doubling". That is a PUSH
 * selection's shard. A full Forge set (schedule or dispatch) runs 35-75 min a
 * shard: run 40725936936 (10-28) took 3,462-3,799 s per shard, while push run
 * 40737267729 the same day took 190-473 s. Since cardtable 9d73808e3 (10-28)
 * the two-hourly cron re-runs a red sha, so full sets became most multi-shard
 * runs, and a held shard now waits behind one. Measured over job-history
 * 10-29..11-11 (shards 2-5, mostly full sets), a
 * shard overlapping another heavy job for over half its run, against one
 * running alone: claw-8 1,864 -> 2,129 s, claw-9 2,412 -> 3,160, claw-4
 * 2,707 -> 3,358, hokon 2,216 -> 3,387 (1.14-1.53x); failures 14% solo, 15%
 * doubled, pooled over 331 and 261 runs. Two doubled shards finish in ~1.3x
 * one; back to back they take 2x. Meanwhile jdk21 jobs were 38% of all queue
 * time (32 h from 11-09 16Z to 11-11 16Z, 542 s average), and in 627 of 824
 * unplaceable jdk21 decisions some node had the slot and the memory and
 * refused ONLY on this hold, which is checked after both.
 *
 * 600 s is about what doubling costs a ~2,400 s shard (0.25 x 2,400): past
 * it, waiting for a heavy-free node is the slower choice. The 2026-10-30
 * claw-8 double (load 52 on 8 cores) was harmed by the watchdog's load
 * trigger rebooting the node, removed the same day (8bf9b59); claw-8 ran 168
 * doubled Forge jobs after it at the same failure rate. The evidence covers
 * two heavy jobs on a node, not three, which is why the tiers stop at two.
 */
export const HEAVY_DOUBLE_HOLD_SEC = 600;

/**
 * The floor a slow-tier node must clear before it takes a job, when
 * {@link SpeedModel.expectedExtraSec} has nothing to estimate from (#83).
 *
 * 100s, the SAME number and the SAME precedent as the fleet's existing backstop
 * backstop gate (`backstop.ts`'s `SATURATION_QUEUE_SECONDS`: the last-30-days
 * p90 of `hadoku-builder` queue time, 1,247 jobs). That gate already answers
 * "how long is a wait that means something" for spilling onto the fleet's
 * other last-resort capacity; a slow claw is the same question asked one
 * tier up, so it reuses the answer rather than picking a second number that
 * could silently drift from it.
 */
export const SPILL_FLOOR_SEC = 100;

/**
 * Slots, and job reserves of memory, an on-demand backstop keeps free for work no
 * other node can carry (#15).
 *
 * The backstop controller grants the backstop node `hadoku-builder` when the claws saturate. Before
 * this, that OVERFLOW (jobs some claw also offers the labels for) could take
 * every backstop slot and memory down to the floor. On 2026-10-27, three cardtable
 * Forge e2e units held hokon from 19:42 (4/4 slots, then 8-9 GB free against
 * an 8,192 MB floor), and dataplatform's `pytest (gpu)` waited 24 minutes for
 * `av1-nvenc`, a label only hokon carries. `ci:queue-health` paged four times.
 *
 * Overflow may take every slot but the last ONE, and must leave one more job
 * reserve (the node's own `requiredMb`) above its floor. Work only the backstop
 * can run is admitted exactly as before. A backstop with a single slot keeps
 * nothing back: it would never serve overflow at all.
 */
export const BACKSTOP_SOLE_CARRIER_SLOTS = 1;

/**
 * Is THIS kind slow enough on `node` to hold it for a faster one (#8)? The
 * node's own tier says nothing here: a node can be normal overall and several
 * times slower on one kind (claw-1's spinning disk under dataplatform's
 * browser e2e). The same two bars the slow tier already uses, applied to one
 * kind:
 *
 * - `ratio >= SLOW_P25`, the line that separates claw-5 from the rest;
 * - `extraSec >= SPILL_FLOOR_SEC`. Holding a job for 100s to save it 25s is a
 *   loss, so a kind that is only slow by seconds is never held.
 *
 * ONE definition, read by the mint path (`refusalFor`) and by the warm path
 * (`slowReposOn`), which GitHub assigns to without asking placement.
 */
export function slowKind(
	model: SpeedModel | undefined,
	node: string,
	repo: string,
	jobName: string
): KindSlowness | null {
	const k = model?.kindSlowness?.(node, repo, jobName) ?? null;
	return k && k.ratio >= SLOW_P25 && k.extraSec >= SPILL_FLOOR_SEC ? k : null;
}

/**
 * The repos `node` must not hold a WARM listener for, with the reason (#8). A
 * warm listener takes any job of its repo with zero queue wait, so the per-kind
 * hold above cannot reach it; a repo with even one slow kind here goes to the
 * mint path instead, where it can be held.
 */
export function slowReposOn(model: SpeedModel | undefined, node: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const k of model?.kindsOn?.(node) ?? []) {
		if (k.ratio < SLOW_P25 || k.extraSec < SPILL_FLOOR_SEC || out.has(k.repo)) continue;
		out.set(k.repo, `slow kind: ${describeKind(k)}`);
	}
	return out;
}

export function describeKind(k: KindSlowness): string {
	const lb = k.lowerBounds ? `, ${k.lowerBounds} unfinished` : '';
	return `${k.job} runs ${k.ratio.toFixed(2)}x here (+${Math.round(k.extraSec)}s, ${k.samples} run(s)${lb})`;
}
