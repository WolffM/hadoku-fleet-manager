/**
 * DRAIN — take a node out of service without killing what it is doing.
 *
 * "Stop giving this box new work, let it finish what it has, tell me when it is
 * idle." That is what you want before a stress test, a reseat, a disk swap, or
 * a kernel that needs a reboot.
 *
 * IT NEEDS TWO ENFORCEMENT POINTS, BECAUSE THE FLEET HAS TWO WAYS OF ASSIGNING
 * WORK, and a drain that only implements one is worse than none — it reports
 * success while the node keeps building.
 *
 *   ephemeral nodes (claw-1, claw-3): the DISPATCHER mints a runner per job, so
 *     placement can simply refuse. Clean, immediate, and nothing external has to
 *     agree.
 *
 *   standing registrations (claw-2, claw-4, claw-5, claw-6, hokon): GITHUB
 *     assigns straight to the runner by label. The dispatcher never sees those
 *     jobs and cannot gate them. The ONLY lever is the `hadoku-builder` label —
 *     "a runner with no haduku-builder label is INVISIBLE to GitHub"
 *     (fleet-loop.ts) — so a drain has to strip it.
 *
 * Five of the seven nodes are the second kind, including claw-2, which is tier0
 * and the busiest box in the fleet. A placement-only drain would have looked
 * like it worked on every one of them.
 *
 * WHY THIS IS PERSISTED AND backstop-hold IS NOT
 * ----------------------------------------------
 * runners/backstop-hold.ts is deliberately in-memory, and its reasoning is
 * sound for what it holds: it is "a statement about what this process did a few
 * seconds ago", so a restarted process correctly believes it has promoted
 * nothing.
 *
 * A drain is the opposite kind of fact. It is an OPERATOR'S INTENTION about a
 * physical machine — somebody is about to open the case — and it must outlive
 * an mgmt-api restart, a deploy, and a crash. A drain that quietly lapsed
 * because a process bounced would put jobs back on a box with its lid off.
 * So it lives on disk, in the manifest directory, beside the other operator
 * state.
 *
 * DRAINING IS NOT DRAINED. `draining` means no new work is being accepted;
 * `drained` means that AND nothing is still running. Only the second one is
 * safe to start maintenance on, and the difference is the entire point of the
 * word "soft" — so the two are never collapsed into one boolean.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { manifest, stateDir } from '../host.js';

/**
 * What a drain is FOR, which decides how it ends.
 *
 *   maintenance  a human took it out and a human puts it back (the default).
 *   training     bootcamp holds it while the node earns its labels.
 *   lease        lent to a tenant's measurement for a fixed window; ends by the
 *                clock (`until`), not by anybody remembering.
 *   hosting      lent to a tenant's RESIDENT service (a hosting node, see
 *                docs/VOCABULARY.md). CI stays off for as long as it lasts, and
 *                the record carries the resources the fleet promised to serve.
 */
export type DrainKind = 'maintenance' | 'training' | 'lease' | 'hosting';

/** What a hosting node promises its tenant. Verified against the cgroup, never this record. */
export interface HostingResources {
	tenant: string;
	memoryMb: number;
	cores: number;
	port: number;
}

/** One node's drain record. Reasons are required; a drain nobody can explain gets undone. */
export interface DrainRecord {
	since: string;
	reason: string;
	by: string;
	kind?: DrainKind;
	/**
	 * When the drain lapses by itself. Absent: it lasts until somebody undoes it.
	 * A lease that needs a person to end it is a lease that runs a week over, so
	 * every reader treats a record past `until` as not there at all.
	 */
	until?: string;
	/** Present only on `kind: 'hosting'`. */
	hosting?: HostingResources;
}

export type DrainState = Record<string, DrainRecord>;

/**
 * A drain that has not started yet. Kept apart from `nodes` because a node can
 * hold one of each: a hosting node keeps its hosting record while a maintenance
 * window is scheduled on top of it, and the window must not erase the promise.
 */
export interface PlannedDrain extends DrainRecord {
	node: string;
	/** When it takes effect. Its `since` is when it was SCHEDULED. */
	from: string;
}

/** The file, whole. `readDrain()` is the effective view of it at one instant. */
export interface DrainDoc {
	nodes: DrainState;
	planned: PlannedDrain[];
}

/**
 * The least notice a tenant gets before its hosting node is taken away.
 * Cardtable asked for 15 minutes so it can move live matches first
 * (hadoku-cardtable docs/requests/FLEET_MANAGER_FORGE_HOSTING.md §4).
 */
export const HOSTING_NOTICE_MS = 15 * 60_000;

const lapsed = (rec: { until?: string }, nowMs: number): boolean => {
	if (!rec.until) return false;
	const t = Date.parse(rec.until);
	// An unparseable `until` is NOT a lapse. Reading garbage as "it ended" would
	// put CI back on a box somebody leased; reading it as "still held" fails safe.
	return Number.isFinite(t) && t <= nowMs;
};

/**
 * Parse the file's text. Empty text is an empty doc; malformed text THROWS
 * (see `readDrain`). The pre-lease file has no `planned` key and reads as none.
 */
export function parseDrainDoc(raw: string): DrainDoc {
	if (!raw.trim()) return { nodes: {}, planned: [] };
	const parsed = JSON.parse(raw) as { nodes?: DrainState; planned?: PlannedDrain[] };
	return {
		nodes: parsed.nodes ?? {},
		planned: Array.isArray(parsed.planned) ? parsed.planned : [],
	};
}

/**
 * THE ONE ANSWER TO "IS THIS NODE HELD RIGHT NOW", for every reader.
 *
 * A current record counts until its `until`. A planned record counts from its
 * `from` until its own `until`, and while it does it wins over the current one:
 * it is the newer intention, and both hold CI off equally. A planned record
 * shows `since: from`, so a reader asking "did work start after the drain"
 * (`drain-check`) measures from when it actually took effect.
 */
export function effectiveDrains(doc: DrainDoc, nowMs: number = Date.now()): DrainState {
	const out: DrainState = {};
	for (const [node, rec] of Object.entries(doc.nodes)) {
		if (!lapsed(rec, nowMs)) out[node] = rec;
	}
	for (const p of doc.planned) {
		const from = Date.parse(p.from);
		// Unparseable `from` is in force NOW — the fail-safe direction again.
		if (Number.isFinite(from) && from > nowMs) continue;
		if (lapsed(p, nowMs)) continue;
		const { node, from: _, ...rec } = p;
		out[node] = { ...rec, since: p.from };
	}
	return out;
}

/** A change to a node's availability that has not happened yet. */
export interface DrainNotice {
	node: string;
	/** `starts`: CI (or a tenant) loses the node. `ends`: a drain lapses on its own. */
	event: 'starts' | 'ends';
	at: string;
	kind: DrainKind;
	reason: string;
}

/** Every scheduled start and every scheduled end still ahead of `nowMs`, soonest first. */
export function drainNotices(doc: DrainDoc, nowMs: number = Date.now()): DrainNotice[] {
	const out: DrainNotice[] = [];
	const ahead = (iso: string | undefined): iso is string => {
		const t = Date.parse(iso ?? '');
		return Number.isFinite(t) && t > nowMs;
	};
	for (const [node, rec] of Object.entries(doc.nodes)) {
		if (ahead(rec.until)) {
			out.push({
				node,
				event: 'ends',
				at: rec.until,
				kind: rec.kind ?? 'maintenance',
				reason: rec.reason,
			});
		}
	}
	for (const p of doc.planned) {
		if (lapsed(p, nowMs)) continue;
		const kind = p.kind ?? 'maintenance';
		if (ahead(p.from))
			out.push({ node: p.node, event: 'starts', at: p.from, kind, reason: p.reason });
		if (ahead(p.until))
			out.push({ node: p.node, event: 'ends', at: p.until, kind, reason: p.reason });
	}
	return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * A moment named on the command line: an ISO timestamp, or a duration from
 * `nowMs` (`20m`, `48h`, `2d`). Garbage THROWS — a typo must never become
 * "now" or "forever" on a box somebody leased.
 */
export function parseWhen(spec: string, nowMs: number = Date.now()): number {
	const d = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(spec.trim());
	if (d) {
		const unit = d[2].toLowerCase();
		const perUnit = unit.startsWith('d') ? 86_400_000 : unit.startsWith('h') ? 3_600_000 : 60_000;
		return nowMs + Number(d[1]) * perUnit;
	}
	// A bare date-time with no zone would be read in this box's local time,
	// which is not the time anybody on another box meant. Require the zone.
	if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(spec.trim())) {
		const t = Date.parse(spec);
		if (Number.isFinite(t)) return t;
	}
	throw new Error(
		`cannot read "${spec}" as a time — use a duration (20m, 48h, 2d) or an ISO timestamp with a zone`
	);
}

/** The doc with every lapsed record removed — what a writer persists. */
export function pruneDrainDoc(doc: DrainDoc, nowMs: number = Date.now()): DrainDoc {
	return {
		nodes: Object.fromEntries(Object.entries(doc.nodes).filter(([, r]) => !lapsed(r, nowMs))),
		planned: doc.planned.filter((p) => !lapsed(p, nowMs)),
	};
}

/**
 * Must this change wait for notice? A node whose CURRENT record is `hosting`
 * has a tenant on it, and anything that takes the node away from that tenant
 * gives it {@link HOSTING_NOTICE_MS} first. Returns why it may not happen at
 * `atMs`, or null when it may.
 */
export function noticeRefusal(
	node: string,
	atMs: number,
	doc: DrainDoc,
	nowMs: number = Date.now()
): string | null {
	const rec = doc.nodes[node];
	if (!rec || rec.kind !== 'hosting' || lapsed(rec, nowMs)) return null;
	if (atMs - nowMs >= HOSTING_NOTICE_MS) return null;
	const tenant = rec.hosting?.tenant ?? 'its tenant';
	return (
		`${node} is hosting for ${tenant}, which is owed ${HOSTING_NOTICE_MS / 60_000} min notice ` +
		`before the node is taken away; this would take effect in ${Math.max(0, Math.round((atMs - nowMs) / 60_000))} min.`
	);
}

const FILE = 'fleet-drain.json';

/**
 * A drain lives in the STATE directory, not the manifest directory.
 *
 * The distinction is the whole bug. `manifestDir` is a path INSIDE a git
 * checkout, and there are two of those: the operator works in
 * ~/repos/hadoku_site and mgmt-api reads ~/srv/hadoku_site. So `fleet drain`
 * run by a human wrote its file into the operator's checkout and the dispatcher
 * — which resolves the other one — never saw it. Measured 2026-09-04: claw-5
 * had been drained since 21:58Z the previous evening for a DRAM fault, the file
 * existed only under ~/repos, and claw-5 went on serving jobs the entire time.
 * A drain that does not reach the dispatcher is not a soft close, it is a note
 * to nobody.
 *
 * `stateDir` is a single absolute location (~/.hadoku-mgmt) that does not depend
 * on which checkout a command was invoked from, so the CLI writes exactly where
 * the dispatcher reads. It is also where every other fact of this kind already
 * lives — job-history, the runner-health ledger and snapshot — which is the
 * company this one should always have kept.
 *
 * Note this was NOT a deploy deleting the file, the earlier reading of it:
 * `git reset --hard` does not remove untracked files and no deploy path runs
 * `git clean`. It never arrived.
 */
const drainPath = (): string => join(stateDir(), FILE);

/**
 * The pre-2026-09-04 location, read ONLY as a fallback.
 *
 * A drain is a safety fact about a physical machine, so the migration cannot be
 * "start looking in the new place and hope". Any drain an operator set before
 * the move must keep being honoured until something rewrites it, or the upgrade
 * itself would silently un-drain a box somebody is about to open.
 */
const legacyDrainPath = (): string => manifest(FILE);

/**
 * Read the drain set.
 *
 * A MISSING FILE IS AN EMPTY DRAIN, and that is correct: nothing has been taken
 * out of service. An UNREADABLE file is not — it is a question we could not
 * answer, and answering "nothing is drained" would put work back onto a node
 * somebody is holding a screwdriver over. So a parse failure THROWS, and the
 * caller decides; every caller here fails closed.
 */
export function readDrain(nowMs: number = Date.now()): DrainState {
	return effectiveDrains(readDrainDoc(), nowMs);
}

/** The whole file, planned drains and lapsed records included. */
export function readDrainDoc(): DrainDoc {
	// New location wins; the legacy one is honoured until a write moves it.
	const path = [drainPath(), legacyDrainPath()].find((p) => existsSync(p));
	if (!path) return { nodes: {}, planned: [] };
	return parseDrainDoc(readFileSync(path, 'utf8'));
}

export function writeDrain(nodes: DrainState, planned: PlannedDrain[] = []): void {
	const doc = { nodes, planned };
	const path = drainPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ $comment: 'Nodes held out of service. `fleet drain` writes this; the dispatcher and the tier ladder both read it. Lives in the state dir, NOT a git checkout — see drain.ts.', ...pruneDrainDoc(doc) }, null, 2)}\n`
	);
	// Exactly one source of truth afterwards. Leaving the legacy file behind
	// would let a stale copy answer for a checkout the reader happens to be in,
	// which is the failure this move exists to end.
	const legacy = legacyDrainPath();
	if (legacy !== path && existsSync(legacy)) rmSync(legacy, { force: true });
}

/** Is this node currently held out of service? */
export function isDraining(node: string, state: DrainState = readDrain()): boolean {
	return Object.prototype.hasOwnProperty.call(state, node);
}

/**
 * Fold a drain into a node's eligibility.
 *
 * Exported separately from the state so the tier ladder and the dispatcher can
 * apply the SAME rule without either importing the other, and so it can be
 * tested without a filesystem.
 */
export function drainOverrides(
	node: string,
	wouldBeEligible: boolean,
	state: DrainState
): { eligible: boolean; reason?: string } {
	const rec = state[node];
	if (!rec) return { eligible: wouldBeEligible };
	// A drain BEATS every promotion, including the backstop's. The backstop
	// promotes to relieve a saturated fleet; if the alternative is placing work
	// on a machine somebody has opened, the queue waits.
	return { eligible: false, reason: `drained: ${rec.reason} (since ${rec.since})` };
}

/**
 * Has a draining node actually gone quiet?
 *
 * `busy` is the count of its runners GitHub reports as running a job. Zero is
 * the only value that makes maintenance safe, and it is deliberately taken from
 * the OBSERVED runner census rather than from anything this module wrote.
 *
 * `hasLiveRegistration` (#90) is a SECOND, independent observation: does
 * GitHub's own runner listing still carry a warm or JIT registration for this
 * node, regardless of whether it is currently busy? A warm listener sitting
 * IDLE is exactly as assignable as a busy one — GitHub hands it work directly,
 * without asking the dispatcher — so `busy === 0` on that registration is not
 * evidence of anything safe. claw-5 read `drained` from a busy-process probe
 * alone while `warm-claw-5-hadoku_site` sat there, idle and still live, and
 * went on to serve 23 more jobs.
 *
 *   - `true`: a registration exists. `draining`, never `drained`, whatever
 *     `busy` says.
 *   - `false`: none exists. Falls through to the `busy`-only rule exactly as
 *     before — this is what every caller that cannot check (or does not need
 *     to, because the node has no warm/JIT surface at all) gets by defaulting
 *     the parameter.
 *   - `null`: the registration listing could not be read. Fails the same
 *     direction `busy === null` already does: `unknown`, never `drained`. A
 *     check that could not look must never be read as "nothing is there".
 */
export function drainStatus(
	node: string,
	busy: number | null,
	state: DrainState = readDrain(),
	hasLiveRegistration: boolean | null = false
): 'active' | 'draining' | 'drained' | 'unknown' {
	if (!isDraining(node, state)) return 'active';
	if (hasLiveRegistration === null) return 'unknown';
	if (hasLiveRegistration) return 'draining';
	// null means the census has not looked. That is NOT drained — reporting it
	// as such is how somebody opens a case on a node that is mid-build.
	if (busy === null) return 'unknown';
	return busy > 0 ? 'draining' : 'drained';
}
