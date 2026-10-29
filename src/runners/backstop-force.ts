/**
 * BACKSTOP FORCE — the green light. `fleet drain` is the red one.
 *
 * "hokon, take CI work now." An operator's intention, time-boxed, written to
 * disk, read on every runner-health tick, and shown on the panel.
 *
 * WHY IT EXISTS. On 2026-10-20/21 the fleet queued 13–22 runs for up to 53
 * minutes twice in one night while hokon sat with 26 GB free. The backstop
 * WANTED hokon every tick (`reason=saturation queue=2684s`) and was refused
 * by the idle gate, because the operator's own sessions held the box at load
 * 30–46. Every way to make hokon take work was a code change — the idle
 * thresholds, the manifest's backstop mode — each a commit, a publish and a
 * hub deploy, and the operator asked four times in capital letters for the
 * switch the system did not have. `docs/planning/queue-pileup-retro-2026-10-21.md`
 * §4.1 is the design; this file is the mechanism.
 *
 * WHAT IT OVERRIDES, AND WHAT IT DOES NOT
 *   - It makes the node ELIGIBLE: runner-health holds it for the dispatcher
 *     whether or not the saturation decision wants it this tick, and whether
 *     or not the box reads idle. The queue it serves is whatever is queued.
 *   - It does NOT beat a drain or a quarantine (`unsafeNode`): red beats green,
 *     because a drain means somebody has the lid off or the store is damaged.
 *   - It does NOT beat the pm2-host rung: a node mid-deploy stays off builder
 *     work until the deploy ends (minutes), exactly as the ladder orders.
 *   - It does NOT beat the dispatcher's admission (memory, /tmp floor,
 *     maxConcurrent). Those are physical; this is policy.
 *
 * TIME-BOXED, BY CONSTRUCTION. A force carries `until`; past it the record is
 * dead whether or not anybody cleared it. The default is an hour and the
 * ceiling six: long enough to drain any backlog the fleet has ever had, short
 * enough that a switch flipped at 1am cannot still be routing CI onto the
 * production desktop next week. `fleet backstop --off <node>` ends it early.
 *
 * PERSISTED, LIKE THE DRAIN, for the same reason drain.ts gives: it is an
 * operator's statement about a machine, and it must outlive the mgmt-api
 * restart that a deploy storm causes eight times an hour. It lives in the
 * STATE dir — one absolute path — never a checkout, so the CLI writes exactly
 * where the tick reads (the 2026-09-04 drain bug).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir as hostStateDir } from '../host.js';
import { writeFileAtomic } from '../lib/atomic-json.js';
import { stateDir as envStateDir } from '../lib/fleet-paths.js';

/**
 * In-process the host says where state lives; `fleet backstop` runs with no
 * host installed and resolves the same location from the environment, exactly
 * as `fleet-paths.ts` documents. One file, two readers, one path.
 */
function stateDir(): string {
	try {
		return hostStateDir();
	} catch {
		return envStateDir();
	}
}

export interface ForceRecord {
	/** ISO time the force was set. */
	since: string;
	/** ISO time it expires. Past this the record is ignored everywhere. */
	until: string;
	reason: string;
	by: string;
}

export type ForceState = Record<string, ForceRecord>;

const FILE = 'fleet-backstop-force.json';

export const FORCE_DEFAULT_MINUTES = 60;
export const FORCE_MAX_MINUTES = 6 * 60;

const forcePath = (): string => join(stateDir(), FILE);

/**
 * Read the force set.
 *
 * A MISSING FILE IS NO FORCE. An UNREADABLE one THROWS: the caller decides,
 * and every caller fails toward "not forced" and SAYS SO — a corrupt switch
 * must neither route work by accident nor vanish silently.
 */
export function readForce(): ForceState {
	const path = forcePath();
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, 'utf8');
	if (!raw.trim()) return {};
	const parsed = JSON.parse(raw) as { nodes?: ForceState };
	return parsed.nodes ?? {};
}

export function writeForce(state: ForceState): void {
	const path = forcePath();
	// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`) — this used to write
	// the live path directly (`F3-non-atomic` debt).
	writeFileAtomic(
		path,
		`${JSON.stringify(
			{
				$comment:
					'Nodes an operator is holding ELIGIBLE for builder work, each until a time. ' +
					'`fleet backstop --force` writes this; runner-health reads it every tick. ' +
					'Lives in the state dir, NOT a git checkout — see backstop-force.ts.',
				nodes: state,
			},
			null,
			2
		)}\n`
	);
}

/** Is `node` forced right now? An expired record is as good as absent. */
export function isForced(node: string, state: ForceState, nowMs: number = Date.now()): boolean {
	const rec = state[node];
	if (!rec) return false;
	const until = Date.parse(rec.until);
	return Number.isFinite(until) && until > nowMs;
}

/** Every force still in effect, oldest first, with the minutes it has left. */
export function activeForces(
	state: ForceState,
	nowMs: number = Date.now()
): { node: string; record: ForceRecord; remainingMin: number }[] {
	return Object.entries(state)
		.filter(([node]) => isForced(node, state, nowMs))
		.map(([node, record]) => ({
			node,
			record,
			remainingMin: Math.ceil((Date.parse(record.until) - nowMs) / 60_000),
		}))
		.sort((a, b) => Date.parse(a.record.since) - Date.parse(b.record.since));
}

/** Drop expired records. Returns the live set; the caller decides whether to write it. */
export function pruneForce(state: ForceState, nowMs: number = Date.now()): ForceState {
	return Object.fromEntries(Object.entries(state).filter(([node]) => isForced(node, state, nowMs)));
}

/**
 * `60m`, `2h`, `90` (minutes). Clamped to [1, FORCE_MAX_MINUTES]; a value
 * that does not parse is an error, never a default — a typo must not become
 * an hour of CI on the production host without the operator seeing it.
 */
export function parseForceMinutes(spec: string | null | undefined): number {
	if (spec === null || spec === undefined || spec === '') return FORCE_DEFAULT_MINUTES;
	const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr)?$/i.exec(spec.trim());
	if (!m) throw new Error(`cannot read duration "${spec}" — use 90m, 2h, or a number of minutes`);
	const n = Number(m[1]);
	const unit = (m[2] ?? 'm').toLowerCase();
	const minutes = unit.startsWith('h') ? n * 60 : n;
	if (!(minutes >= 1)) throw new Error(`duration "${spec}" is under a minute`);
	if (minutes > FORCE_MAX_MINUTES) {
		throw new Error(
			`duration "${spec}" is over the ${FORCE_MAX_MINUTES / 60}h ceiling — set it again later if the queue is still there`
		);
	}
	return minutes;
}

/** Build the record for a force set now. */
export function forceRecord(
	minutes: number,
	reason: string,
	by: string,
	nowMs: number = Date.now()
): ForceRecord {
	return {
		since: new Date(nowMs).toISOString(),
		until: new Date(nowMs + minutes * 60_000).toISOString(),
		reason,
		by,
	};
}

/** One line for a log or a status table. */
export function describeForce(node: string, rec: ForceRecord, nowMs: number = Date.now()): string {
	const left = Math.ceil((Date.parse(rec.until) - nowMs) / 60_000);
	return `${node} forced eligible by ${rec.by} until ${rec.until} (${left} min left): ${rec.reason}`;
}
