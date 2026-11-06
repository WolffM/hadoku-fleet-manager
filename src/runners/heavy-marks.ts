/**
 * HEAVY MARKS ON DISK — the dispatcher's "a heavy job was placed or seen on
 * this node" clock, written where `fleet warm-canary` can read it.
 *
 * The warm cache withholds a node's listener while it runs a heavy job
 * (#102.4), and it decides that from TWO sources: the node probe's
 * `busyRepos`, and this mark (`dispatch-warm-cache.ts`'s `runningHeavyNow`).
 * The mark covers what the probe cannot see yet: a heavy job minted but not
 * started, the seconds between back-to-back heavy shards, and the two probes
 * after the last one ends. The canary ran in its own process and read only
 * the probe, so it judged a stricter rule than the cache runs: on 2026-11-05
 * every one of its seven reds (claw-4 20:00Z, claw-6 22:30Z, claw-10 22:31Z,
 * claw-8 23:30Z, claw-4 + claw-8 23:31Z, claw-6 00:00Z) was a node inside
 * this window, refilled within two minutes with no one touching it.
 *
 * In-process, `dispatch-pass-state.ts`'s map stays the source the warm tick
 * reads; this file is its copy for another process, rewritten whenever a pass
 * sets a mark. Lost or unreadable, the canary sees no marks and scores every
 * node, which is the strict direction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../host.js';
import { writeJsonAtomic } from '../lib/atomic-json.js';

/**
 * How long a node stays "running heavy" for the WARM tick after a pass placed
 * or saw a heavy job there — two fast-loop probes, by which time the probe's
 * own repo-level attribution has caught up.
 */
export const HEAVY_MARK_MS = 120_000;

/**
 * How long after a mark lapses the warm cache may take to refill the node:
 * one warm tick (60 s, `WARM_CACHE_INTERVAL_MS`) to come round, plus a mint.
 * Measured on 2026-11-05: 9 s to 51 s from a lapse to a live listener.
 */
export const HEAVY_MARK_REFILL_MS = 120_000;

export const HEAVY_MARKS_FILE = 'heavy-marks.json';

/** node -> epoch ms of the last pass that placed or saw a heavy job there. */
export type HeavyMarks = Readonly<Record<string, number>>;

export function writeHeavyMarks(marks: ReadonlyMap<string, number>, dir = stateDir()): void {
	writeJsonAtomic(join(dir, HEAVY_MARKS_FILE), Object.fromEntries(marks), { fsync: false });
}

/**
 * The marks on disk: `{}` when there is no file yet, `null` when there is one
 * that does not parse, so the caller can say it could not read them.
 */
export function readHeavyMarks(dir = stateDir()): HeavyMarks | null {
	const path = join(dir, HEAVY_MARKS_FILE);
	if (!existsSync(path)) return {};
	try {
		const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
		return Object.fromEntries(
			Object.entries(doc).filter((e): e is [string, number] => Number.isFinite(e[1]))
		);
	} catch {
		return null;
	}
}

/**
 * Is `node` inside the window where the warm cache may rightly hold no
 * listener because of a heavy job: the mark itself, then the refill after it?
 * Returns the mark's age in ms when it is, `null` when it is not.
 */
export function heavyMarkWithholds(marks: HeavyMarks, node: string, nowMs: number): number | null {
	const at = marks[node];
	if (at === undefined) return null;
	const age = nowMs - at;
	return age >= 0 && age < HEAVY_MARK_MS + HEAVY_MARK_REFILL_MS ? age : null;
}
