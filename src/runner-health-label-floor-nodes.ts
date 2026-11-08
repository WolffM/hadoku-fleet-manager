/**
 * Per-NODE offline alerting — the "fleet is DEGRADED, floor still met" half
 * of `checkLabelFloor`, independent of the per-label floor alerting in
 * `runner-health-label-floor-alerts.ts`. Split out of
 * `runner-health-label-floor.ts` (wave shrink-1 lane C).
 *
 * TWO SEPARATE LADDERS LIVE HERE (wave gates1 lane A2). The ORIGINAL one (the
 * `offlineTicks`/`offlineRepeats` maps, the 1h/4h/12h/24h backoff, the
 * `runner-offline:<node>` ledger key) is unchanged: a dead-but-redundant box
 * is still a QUIET ledger row, not a page — see the header below this one.
 *
 * THE NEW ONE is a REAL, loud Discord page (`@here`), gated on the node
 * having been offline for `OFFLINE_PAGE_MS` (2h) CONTINUOUSLY. It exists so
 * `scripts/lib/known-down.mjs` has something genuine to skip ssh-sweep gates
 * on: until this landed, the only per-node signal was the quiet ledger row
 * above, which is a `logger.warn` nobody reads, not an alert — so "known
 * down" would have meant "declared down by a helper nobody can see act",
 * which is exactly the silencer AGENTS.md forbids. See
 * `scripts/lib/known-down.mjs`'s own header for the read side.
 *
 * WHY A SEPARATE, DISK-BACKED RECORD (`runner-down-page.json`) RATHER THAN A
 * KEY IN THE EXISTING ALERT LEDGER. `src/lib/alert-ledger.ts`'s
 * `runner-health-alerts.json` is a `Record<string, ISO-time>` whose load AND
 * save both PRUNE any entry older than `LEDGER_RETENTION_MS` (24h) — right
 * for a "last time this fired" marker that keeps getting refreshed, wrong for
 * a "first time this started" marker that must NOT change while the outage
 * continues: a node down for 3 days would have its `since` pruned on the
 * first save past 24h, silently losing the duration this whole mechanism
 * exists to measure. This module's own file keeps `since` (first continuous
 * offline tick, set once) and `lastPage` (last loud page, refreshed at most
 * every `OFFLINE_REPAGE_MS`) in ONE record per node, with no generic decay —
 * only this module writes it, and it is cleared outright on recovery.
 *
 * DURATION SURVIVES A RESTART. `offlineTicks`'s in-memory count does not — a
 * controller bounced mid-outage would otherwise either never reach 2h (if the
 * count resets to 0) or page immediately on every restart (if it did not).
 * `since` is read from disk before being trusted, so the 2h clock is anchored
 * to the first tick that ever observed the node down, not to how long THIS
 * process has been running.
 *
 * `floorAlreadyBreached` does NOT gate the loud page — only the original
 * quiet ladder. That suppression exists because the backstop PROMOTES hokon
 * in a full outage, which is a CAPACITY story; this page is about WHICH node
 * is down, a different question the tracker's decision says must still be
 * answered even while the floor is breached.
 *
 * A DRAINED NODE (any `kind`, `reboot` included — see `src/runners/drain.ts`)
 * DOES NOT PAGE: somebody already has hands on it. An unreadable drain record
 * fails the OTHER way from a drained one — AGENTS.md's "I could not look must
 * never render as nothing is wrong" — so a throw from `readDrain()` is read
 * as "nothing is draining" (page), never as "everything is" (suppress).
 *
 * `lastPage` IS WRITTEN ONLY AFTER A CONFIRMED POST (manager fix #1, wave
 * gates1 lane A2 review). `postDiscord` can resolve `{ posted: false }`
 * (sink refused it, no webhook configured) or reject outright — and writing
 * `lastPage` regardless, before the post even settles, would let
 * `known-down.mjs` skip a node that nobody was actually paged about: the
 * exact silent-page shape the settled rule forbids. So `postLoudPage` fires
 * the post, and only its OWN `.then` — on `result.posted === true` — writes
 * `lastPage` and saves. `postPending` (node names with a post in flight)
 * stops the NEXT tick from firing a second real Discord post for the same
 * node while the first is still unresolved; if the process dies mid-flight,
 * the next tick may re-post, which is the acceptable failure mode (a stray
 * extra page beats a silently-skipped gate).
 *
 * RECOVERY IS TWO DIFFERENT FACTS, NOT ONE (manager fix #2). A node this tick
 * observed ONLINE is genuinely back — that is what "back online" means. A
 * node that simply VANISHED from tracking (no longer in the runner listing,
 * no longer an ephemeral node with known state) was never observed to
 * recover; it was just not reported on. Posting "back online" for the second
 * case says something nobody observed. `recoverDownPageOnline` is the first
 * case; `recoverDownPageVanished` is the second and, if a page had fired,
 * posts a neutral "cleared, not resolved" line instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, postDiscord, recordAlertQuietly, stateDir } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';
import { nodeOf } from './runners/census.js';
import { isDraining, readDrain, type DrainState } from './runners/drain.js';
import { clearAlert, pagedAlerts } from './lib/alert-ledger.js';
import { DAY_MS, hours, repageDue } from './lib/job-runner.js';
import { TICK_INTERVAL_MS, OFFLINE_TICKS_BEFORE_ALERT } from './lib/runner-health-shared.js';
import { selfHostname } from './lib/runner-health-shared.js';
import type { GhRunner } from './lib/github-client.js';
import type { ClawState } from './lib/fleet-vocabulary.js';

/**
 * NODE name → consecutive ticks seen OFFLINE. Keyed by node, not runner,
 * so one dead box is one message rather than one per registration.
 *
 * The `claw-N-b` second instances this was written for were retired on
 * 2026-08-24, but the grouping is not vestigial: `hokon-tenhands` is a live
 * second registration on hokon (443 job records), and a JIT runner is named per
 * job. `nodeOf` folds both.
 */
const offlineTicks = new Map<string, number>();

/** NODE name → how many times its outage has been re-announced. */
const offlineRepeats = new Map<string, number>();

/**
 * Escalating re-alert schedule for a sustained outage, mirroring heartbeat.ts
 * and worker-health-alerts. A dead node needs hands and may wait days; a
 * fixed hourly ping for a condition the operator already knows about is the
 * noise that teaches people to mute the channel.
 */
const OFFLINE_REPEAT_BACKOFF_MS = [
	1 * 60 * 60 * 1000,
	4 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000,
	24 * 60 * 60 * 1000,
];

/** How long a node must be offline, CONTINUOUSLY, before the loud page fires. */
export const OFFLINE_PAGE_MS = 2 * 60 * 60 * 1000;

/** At most once per this long while the loud page's condition still holds. */
export const OFFLINE_REPAGE_MS = DAY_MS;

/** This module's own state file — one writer, never read through the generic alert ledger. */
const DOWN_PAGE_FILE = 'runner-down-page.json';
const downPagePath = (): string => join(stateDir(), DOWN_PAGE_FILE);

interface DownPageRecord {
	/** First tick this node was observed continuously offline. Never overwritten while down. */
	since: string;
	/** Last time the loud page actually fired. Absent: it has not paged yet. */
	lastPage?: string;
}

/** NODE name → its offline-page record. Persisted; see the module header. */
let downPage: Record<string, DownPageRecord> = {};
let downPageLoaded = false;

function loadDownPage(): void {
	if (downPageLoaded) return;
	downPageLoaded = true;
	try {
		const raw = JSON.parse(readFileSync(downPagePath(), 'utf8')) as Record<string, unknown>;
		for (const [node, value] of Object.entries(raw)) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
			const rec = value as { since?: unknown; lastPage?: unknown };
			if (typeof rec.since !== 'string') continue;
			downPage[node] =
				typeof rec.lastPage === 'string'
					? { since: rec.since, lastPage: rec.lastPage }
					: { since: rec.since };
		}
	} catch {
		// Missing file (nothing has ever been tracked), or unreadable/corrupt.
		// Starting empty under-counts an outage already in progress — the next
		// observed tick re-anchors `since` to NOW, which only ever delays a page,
		// never fires one early or stays silent forever (the file is rewritten
		// on the very next tick that sees the node down).
	}
}

function saveDownPage(): void {
	try {
		writeJsonAtomic(downPagePath(), downPage);
	} catch (err) {
		logger.warn(
			`[runner-health] could not persist ${DOWN_PAGE_FILE}: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

/** Fire-and-log: a RECOVERY note is informational, never a fact a gate reads back. */
function post(content: string): void {
	void postDiscord(content, 'runner-health').catch((err: unknown) => {
		logger.warn(
			`[runner-health] offline-page post failed: ${err instanceof Error ? err.message : String(err)}`
		);
	});
}

/** NODE names with a loud page currently in flight — see the module header. */
const postPending = new Set<string>();

/**
 * Fire the loud page, and record `lastPage` ONLY once `postDiscord` confirms
 * delivery (`posted: true`). A rejected post, or one that resolves
 * `posted: false`, leaves the node's record exactly as it was — still
 * `since`-only, so `known-down.mjs` keeps treating it as a live finding
 * rather than skipping it on a page nobody received (manager fix #1).
 */
function postLoudPage(node: string, content: string): void {
	if (postPending.has(node)) return; // one in flight for this node already
	postPending.add(node);
	void postDiscord(content, 'runner-health')
		.then((result) => {
			if (!result.posted) {
				logger.warn(
					`[runner-health] offline page for ${node} was not delivered (${result.lastError ?? 'no reason given'}) — not recorded as paged`
				);
				return;
			}
			// The node may have recovered while this post was in flight — do not
			// resurrect a cleared record.
			const rec = downPage[node];
			if (rec === undefined) return;
			downPage[node] = { ...rec, lastPage: new Date().toISOString() };
			saveDownPage();
		})
		.catch((err: unknown) => {
			logger.warn(
				`[runner-health] offline page for ${node} failed: ${err instanceof Error ? err.message : String(err)}`
			);
		})
		.finally(() => {
			postPending.delete(node);
		});
}

/** Is `node` already somebody's business — drained (any kind, `reboot` included)? */
function isHandled(node: string, drain: DrainState): boolean {
	return isDraining(node, drain);
}

/**
 * The loud half: page once `node` has been offline OFFLINE_PAGE_MS straight,
 * at most once per OFFLINE_REPAGE_MS after that, never while it is drained or
 * mid-reboot, and NEVER gated on `floorAlreadyBreached` — see the module
 * header for why that suppression does not apply here.
 */
function maybePageLoudly(node: string, names: string[], drain: DrainState): void {
	const rec = downPage[node];
	if (!rec) return;
	const sinceMs = Date.parse(rec.since);
	if (!Number.isFinite(sinceMs)) return; // unparseable: wait for a fresh `since` next tick
	const downForMs = Date.now() - sinceMs;
	if (downForMs < OFFLINE_PAGE_MS) return;
	if (isHandled(node, drain)) return;
	if (rec.lastPage && !repageDue(rec.lastPage, Date.now(), OFFLINE_REPAGE_MS)) return;

	const instances = names.length > 1 ? ` (${names.join(', ')})` : '';
	postLoudPage(
		node,
		`🔴 @here **runners** on \`${selfHostname()}\`: \`${node}\`${instances} has been OFFLINE for ` +
			`${hours(downForMs)} straight — this needs hands, not just capacity.`
	);
}

/** Node observed ONLINE this tick: it is genuinely back. One recovery post if a page had fired. */
function recoverDownPageOnline(node: string): void {
	const rec = downPage[node];
	if (rec === undefined) return;
	if (rec.lastPage) {
		const sinceMs = Date.parse(rec.since);
		const downFor = Number.isFinite(sinceMs) ? hours(Date.now() - sinceMs) : 'a while';
		post(`✅ \`${selfHostname()}\`: \`${node}\` is back online after ${downFor} offline.`);
	}
	delete downPage[node];
	saveDownPage();
}

/**
 * Node VANISHED from tracking (not reported up or down this tick) — this is
 * NOT an observation that it recovered, so it must never say "back online".
 * If a page had fired, say plainly that the record is being cleared, not
 * resolved (manager fix #2).
 */
function recoverDownPageVanished(node: string): void {
	const rec = downPage[node];
	if (rec === undefined) return;
	if (rec.lastPage) {
		post(
			`\`${node}\` is no longer reported by runner-health — its down page is cleared, not resolved.`
		);
	}
	delete downPage[node];
	saveDownPage();
}

/**
 * Indirection purely so tests can SEE the ledger-only path.
 *
 * A quiet record makes no fetch, so the stubbed-fetch harness these tests use
 * cannot observe it — and a test that only asserted "nothing was posted to
 * Discord" would keep passing if the condition stopped being DETECTED at all,
 * which is the failure that matters. This lets them assert the record instead
 * of its absence.
 */
export let quietRecorder: (content: string, source: string) => void = recordAlertQuietly;

/** Test-only seam. */
export function __setQuietRecorderForTesting(
	fn: ((content: string, source: string) => void) | null
): void {
	quietRecorder = fn ?? recordAlertQuietly;
}

/**
 * Per-node offline alerting (fleet DEGRADED, floor still met).
 *
 * The label-floor check only fires at ZERO online. With claw-1 and claw-2 up,
 * claw-3 sat dead for a full day and nothing ever said so — found by hand on
 * 2026-08-15, Tailscale reporting "last seen 1d ago". The first node to die is
 * the one worth hearing about; by the time the floor breaks, CI is already
 * stopped.
 *
 * The ORIGINAL ladder below (quiet, hourly-backed-off, floor-breach-aware) is
 * unchanged. The LOUD page (`maybePageLoudly`/`recoverDownPageOnline`/
 * `recoverDownPageVanished` above) is a second, independent mechanism added
 * for wave gates1 lane A2 — see the module header.
 */
export function runOfflineNodeAlerts(
	runners: readonly GhRunner[],
	fleetNodes: readonly string[],
	ephemeral: ReadonlySet<string>,
	clawState: Record<string, ClawState>,
	floorAlreadyBreached: boolean,
	onlineNames: string
): void {
	// Group by NODE first: one dead claw hosts two runner instances, and
	// announcing each separately doubles every message for a single fault.
	// `fleetNodes`, loaded once above, is what lets `hokon-tenhands` fold
	// onto `hokon` and a JIT runner onto the node that minted it. Without
	// it every instance name is its own "node" and one dead box reports
	// twice.
	//
	// AN EPHEMERAL NODE IS JUDGED BY ITS PROBE, NOT THIS LISTING. Its only
	// registrations here are JIT runners, and a JIT runner reads `offline`
	// between its mint and its listener connecting and again after its job,
	// until GitHub drops it. A tick that caught claw-8 in that gap counted as
	// a tick down, and a later one did the same, so `claw-8 OFFLINE for 20
	// min` was written on 2026-10-22 03:16Z while it ran a job every few
	// minutes. claw-9 on 2026-10-16 17:30Z was the same shape. And a dead
	// ephemeral node has no registrations at all, so this listing could
	// only ever accuse a live one. `deriveClawState` already draws this line
	// from the fast loop's probe; `unreachable` there is what down means.
	// An unprobed node (no state yet) holds its count, neither direction.
	const byNode = new Map<string, { names: string[]; allOffline: boolean }>();
	for (const r of runners) {
		const m = nodeOf(r.name, fleetNodes);
		if (ephemeral.has(m)) continue;
		const e = byNode.get(m) ?? { names: [], allOffline: true };
		e.names.push(r.name);
		if (r.status === 'online') e.allOffline = false;
		byNode.set(m, e);
	}
	for (const m of ephemeral) {
		const st = clawState[m];
		if (st === undefined) continue;
		byNode.set(m, { names: [], allOffline: st === 'unreachable' });
	}

	loadDownPage();

	// Still being watched this tick, either in the listing or as an ephemeral
	// node with a known (not yet probed) state. Anything else was not seen
	// down OR up — it simply was not reported on — and both ladders reset,
	// same rule `offlineTicks` always used.
	const stillTracked = (m: string): boolean =>
		byNode.has(m) || (ephemeral.has(m) && clawState[m] === undefined);

	// CONSECUTIVE ticks, or it is not "for 20 min". A node that is in no
	// listing this tick was not seen down, so its count starts over — the
	// count is what the message multiplies into a duration.
	for (const m of offlineTicks.keys()) {
		if (stillTracked(m)) continue;
		offlineTicks.delete(m);
		offlineRepeats.delete(m);
		clearAlert(`runner-offline:${m}`);
	}
	for (const m of Object.keys(downPage)) {
		if (stillTracked(m)) continue;
		recoverDownPageVanished(m);
	}

	// Read the drain record ONCE per tick, not once per node. An unreadable
	// record (readDrain() throws on a corrupt file) must not silence a page —
	// AGENTS.md — so it is read as "nothing is draining", never the reverse.
	let drain: DrainState = {};
	try {
		drain = readDrain();
	} catch (err) {
		logger.warn(
			`[runner-health] drain record unreadable, treating as nothing drained (page, do not silence): ` +
				(err instanceof Error ? err.message : String(err))
		);
	}

	for (const [node, e] of byNode) {
		const key = `runner-offline:${node}`;
		// A node only counts as down when EVERY instance on it is offline —
		// one instance dying while its twin serves is a runner fault, not a
		// dead box, and the label floor already covers the capacity question.
		if (!e.allOffline) {
			offlineTicks.delete(node);
			offlineRepeats.delete(node);
			clearAlert(key);
			recoverDownPageOnline(node);
			continue;
		}

		// First tick ever observed continuously down: anchor `since` now, so a
		// restart mid-outage never loses it (read back from disk above).
		if (downPage[node] === undefined) {
			downPage[node] = { since: new Date().toISOString() };
			saveDownPage();
		}
		maybePageLoudly(node, e.names, drain);

		const seen = (offlineTicks.get(node) ?? 0) + 1;
		offlineTicks.set(node, seen);
		if (floorAlreadyBreached || seen < OFFLINE_TICKS_BEFORE_ALERT) continue;

		const repeats = offlineRepeats.get(node) ?? 0;
		const wait = OFFLINE_REPEAT_BACKOFF_MS[Math.min(repeats, OFFLINE_REPEAT_BACKOFF_MS.length - 1)];
		const last = pagedAlerts[key] ? Date.parse(pagedAlerts[key]) : 0;
		if (repeats > 0 && Date.now() - last < wait) continue;

		const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
		const downFor = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
		const instances = e.names.length > 1 ? ` (${e.names.join(', ')})` : '';
		// Bypasses alertOnce deliberately: that helper is a fixed hourly window,
		// and this condition needs the escalating ladder instead.
		pagedAlerts[key] = new Date().toISOString();
		offlineRepeats.set(node, repeats + 1);
		// LEDGER ONLY. Read the message: capacity is fine and nothing is
		// queuing, so there is no action that has to happen now — the box needs
		// hands on it eventually, which is a morning-read item, not a ping. It
		// was 24 of the 114 runner-health alerts in the fifteen days to
		// 2026-08-28, all of them announcing that nothing was wrong. The
		// escalating ladder above is kept: it still paces the ledger rows, so a
		// box down for a week does not write one every ten minutes.
		//
		// The floor breach and the all-claws-down backstop still PING — this is
		// only the case where redundancy did its job. The LOUD page above (2h+,
		// drain-aware, floor-breach-independent) is the separate mechanism that
		// actually pings for "which node", added wave gates1 lane A2.
		quietRecorder(
			`⚠️ **runners** on \`${selfHostname()}\`: \`${node}\`${instances} OFFLINE for ${downFor}. ` +
				`CI has capacity (online: ${onlineNames}) and nothing is queuing — the box needs power/network.`,
			'runner-health'
		);
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetOfflineNodeAlertsForTesting(): void {
	offlineTicks.clear();
	offlineRepeats.clear();
	quietRecorder = recordAlertQuietly;
	// Same "mark as loaded, wipe in-memory" shape as alert-ledger.ts's own
	// test reset: a previous test's writes to the shared test state dir must
	// never leak into the next test's read.
	downPageLoaded = true;
	downPage = {};
	// A pending post from a killed-off previous test must never block the next
	// test's own attempt at the same node name.
	postPending.clear();
}

/**
 * Re-read `runner-down-page.json` from disk, as a fresh process would. Test
 * seam, for proving the 2h clock survives a restart: a test seeds the file
 * directly, calls this to force the reload `__resetOfflineNodeAlertsForTesting`
 * deliberately skips, then ticks and checks the page fires (or doesn't)
 * based on what was ALREADY on disk, not on this process's own history.
 */
export function __reloadDownPageForTesting(): void {
	downPageLoaded = false;
	loadDownPage();
}
