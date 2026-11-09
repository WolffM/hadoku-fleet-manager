/**
 * WARM HOLDS ON DISK — the warm tick's own "I am keeping this node's slot
 * empty" record, written where `fleet warm-canary` can read it.
 *
 * The warm tick holds a node out of the warm cache while it runs a heavy-kind
 * job (#102.4) or is drained, and refills it on the first tick after the
 * reason ends: 60 s to come round, plus a mint. The canary is a separate
 * process on its own clock, and judged those nodes from what IT could see at
 * :00 — the heavy job already finished, the drain already lifted — so it
 * scored a node the tick had not yet had a chance to refill. Measured
 * 2026-11-07..09 (fleet-manager#79): every intermittent canary red, about 11–15%
 * of first attempts since 11-01, was a node held this way and refilled
 * 10–90 s after the canary looked; claw-6 at 14:31Z on 11-09 was held by the
 * tick for a heavy job the canary's own probe did not see at all.
 * `job-history.jsonl` cannot close that gap: it lands 1–2 min after a job ends.
 *
 * So the tick says what it decided. Only HEAVY and DRAIN holds are recorded —
 * the two measured — and only for {@link WARM_HOLD_REFILL_MS} after the last
 * tick that held, so a node the tick stopped holding and then failed to refill
 * is scored again within minutes. A slow-tier or space hold is not recorded:
 * the canary already sets slow nodes aside itself, and a space refusal is a
 * fault that should stay visible. Lost or unreadable, the canary sees no holds
 * and scores every node — the strict direction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../host.js';
import { writeJsonAtomic } from '../lib/atomic-json.js';

/**
 * How long after the tick last held a node the canary leaves it alone: one
 * warm tick (60 s, `WARM_CACHE_INTERVAL_MS`) to come round, a mint, and the
 * margin: the longest measured gap from a heavy eviction to a live listener
 * was claw-8 on 11-09, evicted 04:28Z and refilled 04:32:07Z.
 */
export const WARM_HOLD_REFILL_MS = 180_000;

export const WARM_HOLDS_FILE = 'warm-holds.json';

export type WarmHoldReason = 'heavy' | 'drained';

export interface WarmHold {
	atMs: number;
	reason: WarmHoldReason;
}

/** node -> the last tick that held its slot empty, and why. */
export type WarmHolds = Readonly<Record<string, WarmHold>>;

const holds = new Map<string, WarmHold>();
let dirty = false;

/** The warm tick held `node`'s slot empty this tick. */
export function noteWarmHold(node: string, reason: WarmHoldReason, nowMs: number): void {
	holds.set(node, { atMs: nowMs, reason });
	dirty = true;
}

/** Drops holds past the window and writes the record if anything changed. */
export function flushWarmHolds(nowMs: number, dir = stateDir()): void {
	for (const [node, h] of holds) {
		if (nowMs - h.atMs >= WARM_HOLD_REFILL_MS) {
			holds.delete(node);
			dirty = true;
		}
	}
	if (!dirty) return;
	writeJsonAtomic(join(dir, WARM_HOLDS_FILE), Object.fromEntries(holds), { fsync: false });
	dirty = false;
}

/**
 * The holds on disk: `{}` when there is no file yet, `null` when there is one
 * that does not parse, so the caller can say it could not read them.
 */
export function readWarmHolds(dir = stateDir()): WarmHolds | null {
	const path = join(dir, WARM_HOLDS_FILE);
	if (!existsSync(path)) return {};
	try {
		const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
		return Object.fromEntries(
			Object.entries(doc).filter(
				(e): e is [string, WarmHold] =>
					Number.isFinite((e[1] as WarmHold)?.atMs) &&
					((e[1] as WarmHold).reason === 'heavy' || (e[1] as WarmHold).reason === 'drained')
			)
		);
	} catch {
		return null;
	}
}

/**
 * Is `node` inside the window where the warm tick rightly holds no listener
 * there, or has not yet come round to refill it? Returns the hold's age in ms
 * when it is, `null` when it is not.
 */
export function warmHoldWithholds(doc: WarmHolds, node: string, nowMs: number): number | null {
	const h = doc[node];
	if (!h) return null;
	const age = nowMs - h.atMs;
	return age >= 0 && age < WARM_HOLD_REFILL_MS ? age : null;
}

/** Test seam: forget every in-memory hold. */
export function __resetWarmHoldsForTesting(): void {
	holds.clear();
	dirty = false;
}
