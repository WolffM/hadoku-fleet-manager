/**
 * SHARED HOSTING — a tenant's slice on a node that keeps serving CI.
 *
 * The whole-box role (`fleet hosting` without `--shared`) is a drain of
 * `kind: 'hosting'`: CI is held off the node and the tenant has it alone. That
 * record lives in the drain file because it IS a drain. A shared slice is not:
 * CI keeps the node, and only the slice's share is promised to the tenant. So
 * it lives in its own file, `fleet-hosting.json` in the state dir, and no
 * drain reader can mistake it for "CI off". It also cannot be dropped by
 * one of the drain file's writers, which only carry the keys they know.
 *
 * A NODE MAY HOLD SEVERAL SHARED SLICES, one per tenant (fleet-manager#32).
 * The file kept one record per node until 2026-10-31, and declaring
 * pygmalion on claw-4 replaced archivebot's record: archivebot kept running,
 * unbudgeted by the dispatcher and unchecked by `--check`. Every reader sums
 * or iterates the list; {@link withSlice} and {@link withoutSlice} are the
 * only edits, and neither can touch another tenant's record.
 *
 * THE PRIORITY, operator ruling 2026-10-25: pm2 services and the most
 * critical CI (deploys) come first, then the tenant, then all other CI.
 * pm2 runs in `system.slice`, outside both, and keeps every core the tenant's
 * quota leaves. Deploys run on the controller, which never hosts. So on a
 * hosting claw the tenant outranks every CI job there, and the mechanisms
 * below only have to order those two.
 *
 * ELASTIC, NOT PARTITIONED. Resources the tenant is not using go to CI, and
 * come back the moment the tenant wants them:
 *   - CPU: the slice's `CPUWeight` is 10000 against CI's 100, and its own
 *     `CPUQuota` caps it at the declared cores. Measured on claw-9 on
 *     2026-10-25 with CI saturating 8 CPUs: the slice got 3.96 of the 4 it
 *     asked for. When the slice is idle, CI gets all of them.
 *   - MEMORY: the slice's `MemoryMin` is its declared size, and so is its
 *     parent `hosting.slice`'s. With `memory_recursiveprot`, a parent at 0
 *     caps the child's effective protection at 0. CI's kernel ceiling does not
 *     move. The dispatcher holds back the part of the slice the tenant is not
 *     yet using ({@link heldBackMb}), so no new job is admitted into it. A
 *     running job that grows into it anyway is the one the kernel kills:
 *     every CI unit runs at {@link CI_OOM_SCORE_ADJ}, and the agent at
 *     {@link AGENT_OOM_SCORE_ADJ}.
 *
 * THE AGENT IS A SYSTEM UNIT, run as its own user (cardtable §9, 2026-10-25).
 * The slices are SYSTEM slices, directly under the root cgroup, so the CPU
 * weight is weighed against `user.slice` (where CI runs) and `system.slice`
 * (where pm2 runs). A CI job can't touch the agent without sudo. The CI user
 * keeps NOPASSWD sudo on the claws by operator ruling, so this stops casual
 * same-user access, not a job that deliberately becomes root.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stateDir } from '../host.js';
import type { DrainDoc, DrainNotice, HostingResources } from './drain.js';

/**
 * The OOM score every CI unit runs at. The kernel scores a process at roughly
 * its RAM share × 1000 plus this, so +500 puts any CI process ahead of pm2
 * (0), sshd and the hosting agent in a global OOM. Set on every CI unit,
 * hosting node or not, because CI is the right victim on any box.
 */
export const CI_OOM_SCORE_ADJ = 500;

/** The hosting agent's OOM score. A system unit may go below 0, so the agent goes after all CI. */
export const AGENT_OOM_SCORE_ADJ = -500;

/** The hosting slice's CPU weight. CI's slice keeps systemd's default, 100. */
export const HOSTING_CPU_WEIGHT = 10000;

/** One shared slice: what the tenant was promised, and when the promise ends. */
export interface SharedHosting extends HostingResources {
	since: string;
	by: string;
	reason: string;
	/** Set by `fleet hosting --end`. From then the slice is no longer reserved. */
	until?: string;
}

/** A slice `--remove` took away, kept for {@link ENDED_KEEP_MS} so a reader can tell "ended" from "vanished". */
export interface EndedSlice {
	node: string;
	/** The end the tenant was given; absent when it was removed with `--force` before one. */
	until?: string;
	removedAt: string;
	role?: 'standby';
	epoch?: number;
}

/**
 * A singleton's move, OPEN: `to` is declared and carries `epoch`, `from` still
 * serves. Opened by `fleet hosting <to> --move`; closed by the door when
 * `from`'s slice is ended or removed (committed) or `to`'s is (aborted).
 */
export interface OpenMove {
	from: string;
	to: string;
	epoch: number;
	openedAt: string;
	by: string;
}

/** The last move, once closed. */
export interface ClosedMove extends OpenMove {
	closedAt: string;
	outcome: 'committed' | 'aborted';
}

/**
 * THE APP HALF OF THE PLACEMENT RECORD (fleet-manager#16). Where an app is
 * placed is the slices themselves, by node; this holds only what outlives a
 * slice. `epoch` is the last fencing token issued for the app: it goes up by
 * one each time `fleet hosting` places a primary on a node that did not hold
 * one, a move's open included, and it never goes down, not even when the app
 * holds no slice at all. A per-slice counter could not promise that: the
 * record that carried it is gone the moment its slice is removed.
 */
export interface AppPlacement {
	epoch: number;
	move?: OpenMove;
	lastMove?: ClosedMove;
	ended?: EndedSlice[];
}

export interface HostingDoc {
	nodes: Record<string, SharedHosting[]>;
	/** Per app. Absent until the first epoch is issued, so older files read unchanged. */
	apps?: Record<string, AppPlacement>;
}

/** How long a removed slice stays in its app's `ended` list. */
export const ENDED_KEEP_MS = 24 * 3_600_000;

/** One hosting on a node, whichever kind: `whole` is the drain record, `shared` is this file's. */
export interface HostingOn extends HostingResources {
	mode: 'whole' | 'shared';
	until?: string;
	since?: string;
}

const FILE = 'fleet-hosting.json';
const hostingPath = (dir: string): string => join(dir, FILE);

const lapsed = (rec: { until?: string }, nowMs: number): boolean => {
	if (!rec.until) return false;
	const t = Date.parse(rec.until);
	// Unparseable is NOT lapsed: still reserved is the side that fails safe.
	return Number.isFinite(t) && t <= nowMs;
};

/**
 * Parse the file's text. Empty text is no hosting. Malformed text THROWS, and
 * so does a record without a numeric size, and a tenant listed twice on one
 * node. A reader that cannot tell how much a tenant was promised must not
 * answer "nothing". A node's value written before 2026-10-31 is one record,
 * not a list, and reads as a list of one.
 */
export function parseHostingDoc(raw: string): HostingDoc {
	if (!raw.trim()) return { nodes: {} };
	const parsed = JSON.parse(raw) as {
		nodes?: Record<string, SharedHosting | SharedHosting[]>;
		apps?: Record<string, AppPlacement>;
	};
	const nodes: Record<string, SharedHosting[]> = {};
	for (const [node, value] of Object.entries(parsed.nodes ?? {})) {
		const recs = Array.isArray(value) ? value : [value];
		for (const rec of recs) {
			if (
				typeof rec?.tenant !== 'string' ||
				!Number.isFinite(rec.memoryMb) ||
				!Number.isFinite(rec.cores)
			) {
				throw new Error(`${FILE}: a record for ${node} has no tenant, memoryMb or cores`);
			}
		}
		const tenants = recs.map((r) => r.tenant);
		const twice = tenants.find((t, i) => tenants.indexOf(t) !== i);
		if (twice) throw new Error(`${FILE}: ${node} lists ${twice} twice`);
		if (recs.length) nodes[node] = recs;
	}
	if (parsed.apps === undefined) return { nodes };
	for (const [app, a] of Object.entries(parsed.apps)) {
		// A fencing token that cannot be read must not restart from zero.
		if (!Number.isInteger(a?.epoch) || a.epoch < 0)
			throw new Error(`${FILE}: apps.${app} has no whole-number epoch`);
		if (a.ended !== undefined && !Array.isArray(a.ended))
			throw new Error(`${FILE}: apps.${app}.ended is not a list`);
		const m = a.move;
		if (
			m !== undefined &&
			(typeof m?.from !== 'string' || typeof m.to !== 'string' || !Number.isInteger(m.epoch))
		)
			throw new Error(`${FILE}: apps.${app}.move has no from, to and epoch`);
	}
	return { nodes, apps: parsed.apps };
}

/**
 * The whole file, lapsed records included. A missing file is no hosting.
 * `dir` defaults to the host's state dir; a script, which installs no host,
 * passes its own (`scripts/lib/paths.mjs` `stateDir()`).
 */
export function readHostingDoc(dir: string = stateDir()): HostingDoc {
	const path = hostingPath(dir);
	return existsSync(path) ? parseHostingDoc(readFileSync(path, 'utf8')) : { nodes: {} };
}

/** Write atomically, lapsed records kept: `--remove` is what takes one away, after the units. */
export function writeHostingDoc(doc: HostingDoc, dir: string = stateDir()): void {
	const path = hostingPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ $comment: 'Shared hosting slices: a tenant beside CI, and per app its placement epoch. `fleet hosting` writes this; the dispatcher and `fleet hosting-placement` read it. See src/runners/hosting-record.ts.', ...doc }, null, 2)}\n`
	);
	renameSync(tmp, path);
}

/** Each node's slices still in force at `nowMs`; a node with none is absent. */
export function effectiveSlices(
	doc: HostingDoc,
	nowMs: number = Date.now()
): Record<string, SharedHosting[]> {
	const out: Record<string, SharedHosting[]> = {};
	for (const [node, recs] of Object.entries(doc.nodes)) {
		const live = recs.filter((r) => !lapsed(r, nowMs));
		if (live.length) out[node] = live;
	}
	return out;
}

/** The memory every shared slice in force on `node` was promised, summed. */
export function sharedMbOn(doc: HostingDoc, node: string, nowMs: number = Date.now()): number {
	return (effectiveSlices(doc, nowMs)[node] ?? []).reduce((s, r) => s + r.memoryMb, 0);
}

/**
 * THE ONE ANSWER TO "WHICH TENANTS ARE ON THIS NODE", for every reader that
 * must not take the node away without notice: the reboot cycle, `fleet drain`,
 * `node-status`. Whole-box hosting is the drain record, and is alone on its
 * node; shared is this file, oldest declaration first. Empty: no tenant.
 */
export function hostingsOn(
	node: string,
	drainDoc: DrainDoc,
	hostingDoc: HostingDoc,
	nowMs: number = Date.now()
): HostingOn[] {
	const whole = drainDoc.nodes[node];
	if (whole?.kind === 'hosting' && whole.hosting && !lapsed(whole, nowMs)) {
		return [
			{
				mode: 'whole',
				...whole.hosting,
				...(whole.until ? { until: whole.until } : {}),
				...(whole.since ? { since: whole.since } : {}),
			},
		];
	}
	return [...(effectiveSlices(hostingDoc, nowMs)[node] ?? [])]
		.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
		.map(({ tenant, memoryMb, cores, port, role, epoch, until, since }) => ({
			mode: 'shared' as const,
			tenant,
			memoryMb,
			cores,
			port,
			...(role ? { role } : {}),
			...(epoch !== undefined ? { epoch } : {}),
			...(until ? { until } : {}),
			since,
		}));
}

/** `doc` with `rec` as `node`'s slice for `rec.tenant`: that tenant's record replaced, every other kept. */
export function withSlice(doc: HostingDoc, node: string, rec: SharedHosting): HostingDoc {
	const others = (doc.nodes[node] ?? []).filter((r) => r.tenant !== rec.tenant);
	return { ...doc, nodes: { ...doc.nodes, [node]: [...others, rec] } };
}

/** `doc` without `tenant`'s slice on `node`; the node's key goes when its last slice does. */
export function withoutSlice(doc: HostingDoc, node: string, tenant: string): HostingDoc {
	const nodes = { ...doc.nodes };
	const left = (nodes[node] ?? []).filter((r) => r.tenant !== tenant);
	if (left.length) nodes[node] = left;
	else delete nodes[node];
	return { ...doc, nodes };
}

/**
 * The next fencing token for `app`, and `doc` with it recorded. `seen` is
 * every epoch on the app's records in force, whole-box drains included, so a
 * token is never issued twice even against a hand-edited file. The caller
 * writes the doc BEFORE it writes a record carrying the token: a crash in
 * between skips a number, which is harmless, and never repeats one.
 */
export function issueEpoch(
	doc: HostingDoc,
	app: string,
	seen: readonly number[] = []
): { doc: HostingDoc; epoch: number } {
	const prev = doc.apps?.[app];
	const epoch = Math.max(prev?.epoch ?? 0, ...seen) + 1;
	return {
		doc: { ...doc, apps: { ...doc.apps, [app]: { ...prev, epoch } } },
		epoch,
	};
}

/** `doc` with `move` open for `app`. The epoch must already be issued: {@link issueEpoch}. */
export function withMoveOpen(doc: HostingDoc, app: string, move: OpenMove): HostingDoc {
	const prev = doc.apps?.[app];
	return {
		...doc,
		apps: { ...doc.apps, [app]: { ...prev, epoch: Math.max(prev?.epoch ?? 0, move.epoch), move } },
	};
}

/**
 * `doc` with `app`'s open move closed as `outcome`, kept as `lastMove`, or
 * `doc` itself when no move is open. The epoch is never given back: an
 * aborted move's token stays spent, so the node it was issued to cannot
 * present it again.
 */
export function withMoveClosed(
	doc: HostingDoc,
	app: string,
	outcome: ClosedMove['outcome'],
	closedAt: string
): HostingDoc {
	const prev = doc.apps?.[app];
	if (!prev?.move) return doc;
	const { move, ...rest } = prev;
	return {
		...doc,
		apps: { ...doc.apps, [app]: { ...rest, lastMove: { ...move, closedAt, outcome } } },
	};
}

/**
 * `doc` with `slice` in `app`'s ended list, and every entry older than
 * {@link ENDED_KEEP_MS} dropped. The app's epoch is kept, or started at 0 for
 * an app that never had one, so the list has somewhere to live.
 */
export function withEnded(
	doc: HostingDoc,
	app: string,
	slice: EndedSlice,
	nowMs: number = Date.now()
): HostingDoc {
	const prev = doc.apps?.[app];
	const ended = [...(prev?.ended ?? []), slice].filter(
		(e) => !(nowMs - Date.parse(e.removedAt) > ENDED_KEEP_MS)
	);
	return { ...doc, apps: { ...doc.apps, [app]: { ...prev, epoch: prev?.epoch ?? 0, ended } } };
}

/**
 * Every shared slice's scheduled end still ahead, as the notice `drainNotices`
 * gives a drain. Whole-box hosting is a drain, so its end is already one of
 * those. node-status and the hosting converger read the same list.
 */
export function hostingNotices(doc: HostingDoc, nowMs: number = Date.now()): DrainNotice[] {
	return Object.entries(doc.nodes)
		.flatMap(([node, recs]) => recs.map((r) => [node, r] as const))
		.filter(([, r]) => Number.isFinite(Date.parse(r.until ?? '')) && Date.parse(r.until!) > nowMs)
		.map(([node, r]) => ({
			node,
			event: 'ends' as const,
			at: r.until!,
			kind: 'hosting' as const,
			reason: r.reason,
		}))
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** For this long after a declaration, the whole slice is held back whatever it holds. */
export const HOLD_FULL_MS = 10 * 60_000;

/** Below this, the tenant's agent is not up yet (an idle JVM alone is ~600 MB), so hold back everything. */
export const AGENT_UP_MIN_MB = 256;

/**
 * How much memory admission holds back for a shared slice.
 *
 * Normally the part of the declaration the tenant is not using yet. What it
 * already uses is gone from the node's available memory, so counting it again
 * would hold back twice.
 *
 * The WHOLE declaration is held back:
 *   - when usage is unreadable (we could not look, so assume the tenant needs
 *     everything it was promised);
 *   - for {@link HOLD_FULL_MS} after the declaration;
 *   - while the slice holds less than {@link AGENT_UP_MIN_MB}.
 * The last two are cardtable's ask: a CI job admitted before the agent's JVMs
 * start would otherwise be killed a minute later when they do.
 */
export function heldBackMb(o: {
	declaredMb: number;
	sliceCurrentMb: number | null;
	since: string;
	nowMs?: number;
}): number {
	const { declaredMb, sliceCurrentMb } = o;
	const since = Date.parse(o.since);
	const young = !Number.isFinite(since) || (o.nowMs ?? Date.now()) - since < HOLD_FULL_MS;
	if (sliceCurrentMb === null || !Number.isFinite(sliceCurrentMb) || young) return declaredMb;
	if (sliceCurrentMb < AGENT_UP_MIN_MB) return declaredMb;
	return Math.max(0, Math.round(declaredMb - sliceCurrentMb));
}

/** The parent of every hosting slice. Its weight and protection are what the root cgroup compares. */
export const HOSTING_PARENT_SLICE = 'hosting.slice';

/** The system slice a tenant's resources are served from: `hosting.slice/hosting-<tenant>.slice`. */
export const hostingSliceName = (tenant: string): string => `hosting-${tenant}.slice`;

/** Where that slice's cgroup is, from the root of the cgroup2 mount. */
export const hostingSliceCgroup = (tenant: string): string =>
	`/${HOSTING_PARENT_SLICE}/${hostingSliceName(tenant)}`;

/**
 * The shell that prints each slice's `memory.current` on its own line,
 * `hosting-slice <tenant> <bytes>`, so it can ride on another probe's ssh
 * call. `-` when a slice has no cgroup.
 */
export function sliceUsageProbe(tenants: readonly string[]): string {
	return tenants
		.map(
			(t) =>
				`echo "hosting-slice ${t} $(cat /sys/fs/cgroup${hostingSliceCgroup(t)}/memory.current 2>/dev/null || echo -)"`
		)
		.join('; ');
}

/**
 * Split {@link sliceUsageProbe}'s lines off probe output: the rest, and each
 * tenant's usage in MiB (null if unread; a tenant with no line is absent).
 */
export function takeSliceUsage(out: string | null): {
	rest: string;
	sliceCurrentMb: Map<string, number | null>;
} {
	const sliceCurrentMb = new Map<string, number | null>();
	const rest: string[] = [];
	for (const line of String(out ?? '').split(/\r?\n/)) {
		const m = /^hosting-slice (\S+) (.*)$/.exec(line);
		if (!m) {
			rest.push(line);
			continue;
		}
		const n = /^\d+$/.test(m[2].trim()) ? Number(m[2].trim()) : NaN;
		sliceCurrentMb.set(m[1], Number.isFinite(n) ? Math.round(n / 1048576) : null);
	}
	return { rest: rest.join('\n'), sliceCurrentMb };
}
