/**
 * known-down — which fleet nodes are ALREADY paged, LOUDLY, as offline.
 *
 * WHY THIS EXISTS (wave gates1 §A). One unreachable node (claw-9 offline,
 * site#420; claw-5's key rejected, fleet-manager#18) produced 11-12 separate
 * "I could not reach this node" findings in one morning — claw-cleanup,
 * fleet-preflight, toolchain-refresh, and the audit subs identity,
 * capabilities, throttle, slice, boundary-contracts, tool-inventory,
 * warm-canary — all restating one fact. AGENTS.md's rule still stands: "I
 * could not look" must never render as "nothing is wrong", so a dead node may
 * be skipped as KNOWN DOWN only when something else is ALREADY paging it —
 * never a bare declaration this module invents on its own.
 *
 * THE PAGER THIS MODULE READS, AND WHY IT CHANGED (wave gates1 lane A2). Lane
 * A's first cut of this file read `runner-health-alerts.json`'s
 * `runner-offline:<node>` key — `runOfflineNodeAlerts`
 * (`src/runner-health-label-floor-nodes.ts`)'s QUIET ledger row, written
 * after just `OFFLINE_TICKS_BEFORE_ALERT` (2) consecutive 10-minute ticks
 * (~20 min). That row is real observation, but it is not a PAGE: its only
 * producer is `quietRecorder`, a `logger.warn` nobody is paged by, and the
 * settled rule this wave was blocked on until the tracker resolved it is that
 * a gate may skip a node only once something ELSE already pages it — a quiet
 * ledger row nobody reads does not satisfy that, it is just this module
 * inventing the same declaration one layer removed.
 *
 * `runOfflineNodeAlerts` now ALSO writes a second, genuinely loud mechanism:
 * once a node has been offline `OFFLINE_PAGE_MS` (2h) CONTINUOUSLY, it posts
 * a real `@here` Discord alert and records the fact in its own file,
 * `runner-down-page.json` — one JSON object, `{ [node]: { since, lastPage? } }`.
 * `since` is the first tick that ever observed the node continuously down
 * (set once, never touched again while it stays down); `lastPage` is the ISO
 * time of the most recent loud post, ABSENT until the page has actually
 * fired at least once. THIS is what "known down" means here: `lastPage`
 * present, full stop. A node whose `since` is old but has no `lastPage` yet
 * (still inside its first 2h, or drained/mid-reboot so the page is
 * deliberately withheld) is NOT known-down — it is a real finding, same as
 * before this module existed.
 *
 * THE SAFE DIRECTION. A missing or unreadable or malformed ledger, or a
 * per-node record with no `lastPage`, returns nothing for that node — so
 * every caller behaves exactly as it did before this module existed.
 * Under-reporting (a node that actually is already paged still showing up as
 * a fresh finding) costs a few redundant findings; over-reporting (treating
 * an unreadable file, or a not-yet-paged record, as "already paged, skip it")
 * would be the exact silencer AGENTS.md forbids.
 *
 * `since` REPORTED HERE IS THE FIRST OFFLINE TICK, not the most recent
 * re-page — fixing the caveat the previous version of this file had to carry
 * (the old `runner-offline:<node>` key was overwritten on every re-announce,
 * so `since` there was really "most recently reminded", not "down since").
 *
 * A STALE `lastPage` STOPS COUNTING (manager review, wave gates1 lane A2).
 * `lastPage` is a POSITIVE fact — "I saw this node down and paged about it"
 * — never a negative one, and this module must not trust it forever.
 * `runOfflineNodeAlerts` re-pages a sustained, undrained outage at least
 * every `OFFLINE_REPAGE_MS` (24h; `src/runner-health-label-floor-nodes.ts`).
 * So a `lastPage` older than that means the WRITER stopped — the controller
 * went passive, its loop died, or the node was quietly retired from the
 * fleet — not that the node is still down and still being watched. Reading
 * a stale `lastPage` as "known down" forever would be exactly the silencer
 * this module exists to refuse: a page that happened once, years ago, is
 * not a page that is happening now. `KNOWN_DOWN_MAX_AGE_MS` is that cadence
 * plus one hour of slack for ordinary tick jitter — generous enough that a
 * live writer's normal 24h re-page never trips it, tight enough that a dead
 * one is caught within about a day of going quiet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';

/** The file `runOfflineNodeAlerts`'s loud half writes — this module's one read. */
const DOWN_PAGE_FILE = 'runner-down-page.json';

/** Named once, so every caller's `knownDown` entry and human line agree. */
export const PAGED_BY =
	'runner-health (per-node offline alert, src/runner-health-label-floor-nodes.ts)';

/**
 * How stale a `lastPage` may be before this module stops treating the node
 * as known-down — the 24h re-page cadence (`OFFLINE_REPAGE_MS`,
 * `src/runner-health-label-floor-nodes.ts`) plus one hour of slack. See the
 * module header's "A STALE `lastPage` STOPS COUNTING".
 */
export const KNOWN_DOWN_MAX_AGE_MS = 24 * 60 * 60 * 1000 + 60 * 60 * 1000;

/** Where `runOfflineNodeAlerts` writes — `runner-health-label-floor-nodes.ts`'s own path, read rather than re-derived. */
export function knownDownLedgerPath() {
	return join(stateDir(), DOWN_PAGE_FILE);
}

/**
 * Nodes runner-health's per-node offline alert has ALREADY paged, loudly, as
 * down.
 *
 * @param {{ path?: string, now?: number }} [opts] `path` overrides the
 *   ledger file and `now` overrides the clock — tests only; every real
 *   caller reads `knownDownLedgerPath()` and the real `Date.now()`.
 * @returns {Map<string, { node: string, since: string, pagedBy: string }>}
 *   Empty on a missing, unreadable, or malformed ledger, for any node whose
 *   record has no `lastPage` yet, or whose `lastPage` is older than
 *   `KNOWN_DOWN_MAX_AGE_MS` — see the module header's "safe direction" and
 *   "a stale `lastPage` stops counting".
 */
export function knownDownNodes(opts = {}) {
	const path = opts.path ?? knownDownLedgerPath();
	const now = opts.now ?? Date.now();
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		// Missing file (nothing has ever paged), or unreadable/unparseable.
		// Either way: skip nothing.
		return new Map();
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();

	const out = new Map();
	for (const [node, value] of Object.entries(raw)) {
		if (!node) continue;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
		const rec = value;
		// No page has fired yet (still inside its first 2h, or withheld because
		// the node is drained / mid-reboot) — not known-down. This is the one
		// line that makes "known down" mean "already PAGED", not "already seen
		// offline" (§A item 4's "known-down requires the page").
		if (typeof rec.lastPage !== 'string') continue;
		const lastPageMs = Date.parse(rec.lastPage);
		if (!Number.isFinite(lastPageMs)) continue;
		// A page that happened once, long ago, is not a page that is happening
		// NOW — the writer may have stopped. See "a stale `lastPage` stops
		// counting" above.
		if (now - lastPageMs > KNOWN_DOWN_MAX_AGE_MS) continue;
		const sinceRaw = typeof rec.since === 'string' ? rec.since : rec.lastPage;
		const sinceMs = Date.parse(sinceRaw);
		if (!Number.isFinite(sinceMs)) continue;
		out.set(node, { node, since: new Date(sinceMs).toISOString(), pagedBy: PAGED_BY });
	}
	return out;
}

/** One line a gate can print for a node it is skipping as known down. */
export function knownDownNote(entry) {
	return `skipped ${entry.node}: down since ${entry.since}, paged by ${entry.pagedBy}`;
}
