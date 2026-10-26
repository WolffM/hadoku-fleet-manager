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
import type { DrainDoc, HostingResources } from './drain.js';

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

export interface HostingDoc {
	nodes: Record<string, SharedHosting>;
}

/** A node's hosting, whichever kind: `whole` is the drain record, `shared` is this file's. */
export interface HostingOn extends HostingResources {
	mode: 'whole' | 'shared';
	until?: string;
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
 * so does a record without a numeric size. A reader that cannot tell how much
 * a tenant was promised must not answer "nothing".
 */
export function parseHostingDoc(raw: string): HostingDoc {
	if (!raw.trim()) return { nodes: {} };
	const parsed = JSON.parse(raw) as { nodes?: Record<string, SharedHosting> };
	const nodes = parsed.nodes ?? {};
	for (const [node, rec] of Object.entries(nodes)) {
		if (
			typeof rec?.tenant !== 'string' ||
			!Number.isFinite(rec.memoryMb) ||
			!Number.isFinite(rec.cores)
		) {
			throw new Error(`${FILE}: the record for ${node} has no tenant, memoryMb or cores`);
		}
	}
	return { nodes };
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
		`${JSON.stringify({ $comment: 'Shared hosting slices: a tenant beside CI. `fleet hosting --shared` writes this; the dispatcher reads it. See src/runners/hosting-record.ts.', ...doc }, null, 2)}\n`
	);
	renameSync(tmp, path);
}

/** Records still in force at `nowMs`. */
export function effectiveHosting(
	doc: HostingDoc,
	nowMs: number = Date.now()
): Record<string, SharedHosting> {
	return Object.fromEntries(Object.entries(doc.nodes).filter(([, r]) => !lapsed(r, nowMs)));
}

/**
 * THE ONE ANSWER TO "IS A TENANT ON THIS NODE", for every reader that must
 * not take the node away without notice: the reboot cycle, `fleet drain`,
 * `node-status`. Whole-box hosting is the drain record; shared is this file.
 */
export function hostingOn(
	node: string,
	drainDoc: DrainDoc,
	hostingDoc: HostingDoc,
	nowMs: number = Date.now()
): HostingOn | null {
	const whole = drainDoc.nodes[node];
	if (whole?.kind === 'hosting' && whole.hosting && !lapsed(whole, nowMs)) {
		return {
			mode: 'whole',
			...whole.hosting,
			...(whole.until ? { until: whole.until } : {}),
		};
	}
	const shared = effectiveHosting(hostingDoc, nowMs)[node];
	if (!shared) return null;
	const { tenant, memoryMb, cores, port, until } = shared;
	return { mode: 'shared', tenant, memoryMb, cores, port, ...(until ? { until } : {}) };
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
 * The shell that prints the slice's `memory.current` on its own line, prefixed
 * so it can ride on another probe's ssh call. `-` when the slice has no cgroup.
 */
export function sliceUsageProbe(tenant: string): string {
	return `echo "hosting-slice $(cat /sys/fs/cgroup${hostingSliceCgroup(tenant)}/memory.current 2>/dev/null || echo -)"`;
}

/** Split a {@link sliceUsageProbe} line off probe output: the rest, and the usage in MiB (null if unread). */
export function takeSliceUsage(out: string | null): {
	rest: string;
	sliceCurrentMb: number | null;
} {
	const lines = String(out ?? '').split(/\r?\n/);
	const i = lines.findIndex((l) => l.startsWith('hosting-slice '));
	if (i === -1) return { rest: String(out ?? ''), sliceCurrentMb: null };
	const n = Number(lines[i].slice('hosting-slice '.length).trim());
	lines.splice(i, 1);
	return {
		rest: lines.join('\n'),
		sliceCurrentMb: Number.isFinite(n) ? Math.round(n / 1048576) : null,
	};
}
