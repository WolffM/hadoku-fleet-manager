/**
 * toolchain-deferral-streak — a node that is DEFERRED every night never gets
 * its toolchain refresh, and nothing paged on that until now (wave gates2
 * lane F1a, item 1).
 *
 * `fleet converge-toolchain --refresh`'s PASS 2 can mark a node with real
 * work `deferred` for three independent reasons: an operator's own hold,
 * queue pressure, or running out of the run's own time budget
 * (`scripts/lib/refresh-cycle.mjs`). Any ONE deferral is routine — the next
 * night picks it up — but a node whose queue is ALWAYS under pressure at its
 * turn, or that always sorts last before the budget runs out, can be deferred
 * forever and look identical to a node with nothing to do. The 3-day
 * TOLERANCE_MINUTES doctor check (`toolchain-doctor.mjs`) would eventually
 * catch the resulting drift, but only after the tool itself falls behind —
 * this catches the CADENCE having stopped reaching the node at all, which is
 * the earlier and more specific fact.
 *
 * PERSISTED, under `stateDir()`: a streak kept only in memory resets on every
 * mgmt-api restart (several a day), which would turn "deferred N nights
 * running" into "never". Follows the one-writer rule
 * (`scripts/lib/f-guards/f3-one-writer.json`): this file is the sole writer of
 * `toolchain-deferral-streak.json`.
 *
 * THE SAFE DIRECTION, same shape as `lib/known-down.mjs`: a missing or
 * unreadable file reads as "no streak yet" (an empty object), never as a
 * crash and never as "every node is streaking" — under-reporting costs a
 * missed page for one run, over-reporting would be inventing a finding nobody
 * observed.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';
import { writeFileAtomic } from '../../dist/lib/atomic-json.js';

/** The file this module alone writes. */
export const DEFERRAL_STREAK_FILE = 'toolchain-deferral-streak.json';

/**
 * A node deferred on MORE than this many consecutive nights pages — i.e. a
 * 4th night running. Three misses is the same slack `TOLERANCE_MINUTES`
 * gives the tool-behind check: long enough that one bad night (an operator's
 * hold, a busy queue) is never a page, short enough that a cadence that has
 * genuinely stopped reaching a node is caught within days.
 */
export const DEFERRAL_STREAK_PAGE_AFTER = 3;

export function deferralStreakPath() {
	return join(stateDir(), DEFERRAL_STREAK_FILE);
}

/**
 * The current per-node streak counts. Missing, unreadable, or malformed
 * (not a plain object) all read as "nothing recorded yet" — never a crash,
 * and never silently treated as a reason to page.
 */
export function readDeferralStreaks(path = deferralStreakPath()) {
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out = {};
	for (const [node, n] of Object.entries(raw)) {
		if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[node] = n;
	}
	return out;
}

/**
 * This run's streaks, from last night's and what PASS 2 decided for each
 * node this run. Pure, so the paging rule is testable without a filesystem.
 *
 * A node `deferred` again EXTENDS its streak by one. Any other status —
 * `current`, `updated`, `update-failed`, `held`, `expected-down`,
 * `known-down`, `unreadable`, `rechecked`, `swept`, `planned` — means the
 * cycle actually reached a verdict for it this run, which resets the streak:
 * the cadence is not stuck on that node, whatever else is true of it. A node
 * absent from `statuses` this run (an excluded machine, say) simply carries
 * no entry forward — the streak for a node no longer in the fleet is not
 * kept alive by a file nobody prunes.
 */
export function nextDeferralStreaks(previous, statuses) {
	const next = {};
	for (const { node, status } of statuses) {
		if (status === 'deferred') next[node] = (previous[node] ?? 0) + 1;
	}
	return next;
}

export function writeDeferralStreaks(streaks, path) {
	// `path ?? deferralStreakPath()`, not a default parameter: the F3 one-writer
	// detector (scripts/lib/f-guards/f3-one-writer.test.mjs) traces a write
	// call's path argument through local `const`/`function` declarations ONLY —
	// a default parameter value is invisible to it, so the real path (the
	// literal `DEFERRAL_STREAK_FILE`, reached through `deferralStreakPath()`)
	// has to be reachable from a `const`.
	const target = path ?? deferralStreakPath();
	mkdirSync(dirname(target), { recursive: true });
	writeFileAtomic(target, `${JSON.stringify(streaks, null, 2)}\n`);
}

/**
 * Findings for every node whose streak has crossed the page threshold.
 * `node` is included (never `null`): a deferral streak is specifically about
 * ONE node's cadence, unlike a fleet-wide "nothing was probed" finding.
 */
export function deferralStreakFindings(streaks, pageAfter = DEFERRAL_STREAK_PAGE_AFTER) {
	return Object.entries(streaks)
		.filter(([, n]) => n > pageAfter)
		.map(([node, n]) => ({
			node,
			kind: 'deferral-streak',
			reason:
				`deferred ${n} night(s) in a row — the toolchain refresh has not reached this node ` +
				`since, whatever its own reason each night (an operator hold, queue pressure, or the ` +
				`run's time budget)`,
		}));
}
