/**
 * dispatch-tick.ts's one-time hydration of the announced-stuck book from disk.
 *
 * Wave 5r lane B split of dispatch-tick.ts (plan: 800-line ceiling, pure
 * move): unmodified apart from the `__resetWarnedStuckLoadedForTesting` seam
 * `warnedStuckLoaded` needed once it stopped being assignable from the
 * importing module (an ES module import binding is read-only) — dispatch-
 * tick.ts's own reset seams call the setter instead of assigning the flag.
 */
import { readFileSync } from 'node:fs';

import {
	warnedStuck,
	reasonOf,
	complainOnce,
	stuckStorePath,
	capAnnouncedStuck,
} from './stuck-runs.js';

let warnedStuckLoaded = false;

/**
 * The book, from disk. Once per process.
 *
 * UNREADABLE MEANS RE-ANNOUNCE, which is the safe direction and the opposite of
 * `readProbeIntents`'s. A lost book costs one duplicated warning per run; a book
 * that failed open in the other direction would swallow a genuinely new zombie
 * and this whole mechanism would have made the fleet quieter about a real
 * failure. It still SAYS WHY — a corrupt file and a missing one are different
 * jobs, and only one of them is normal.
 */
export function loadWarnedStuck(): void {
	if (warnedStuckLoaded) return;
	warnedStuckLoaded = true;
	const path = stuckStorePath();
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (e) {
		// ENOENT is the normal state of a fleet that has never seen a zombie.
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			complainOnce(
				'read',
				`could not read ${path}: ${reasonOf(e)} — stuck runs will be re-announced`
			);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		complainOnce('parse', `${path} is not parseable JSON (${reasonOf(e)}) — starting a fresh book`);
		return;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		complainOnce('parse', `${path} is not a JSON object — starting a fresh book`);
		return;
	}
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof v === 'string') warnedStuck.set(k, v);
	}
	capAnnouncedStuck();
}

/** Test seam: `warnedStuckLoaded` is a live import binding and so cannot be
 *  assigned from outside this module — see the header above. */
export function __resetWarnedStuckLoadedForTesting(): void {
	warnedStuckLoaded = false;
}
