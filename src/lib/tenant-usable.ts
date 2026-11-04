/**
 * CAN THIS CLAW SERVE THIS TENANT NOW, and so: DOES HOKON STEP IN?
 *
 * The operator, 2026-11-04: every hosted service runs on three claws minimum
 * plus hokon as a backstop, and "fleet-manager decides how that works". This is
 * that decision's one predicate. Two readers share it, with different triggers
 * on purpose:
 *
 *   - cardtable (agent kind) reads `backstops[]` in `fleet node-status --json`.
 *     A match is stateless and cheap to place, so hokon takes a new match the
 *     moment no claw is usable and gives the next one back the moment one is.
 *   - the app layer's lease follower (services, private R11.2) keeps lease
 *     evidence from each copy's own /health as its primary trigger and its own
 *     5 min / 10 min timers, because a cold copy pays a restore. It uses this
 *     as a second input: a claw that is slow on /health but usable here is not
 *     a reason to start hokon, and failback needs a usable claw.
 *
 * Being below `slices.min` is NOT a reason to use hokon: that is a shortfall
 * the converger fills with another claw. hokon is the emergency backstop.
 *
 * READS ONLY OBSERVED STATE, from a node-status row:
 *   reachable                          the controller reached the node this call
 *   drain.kind                         an active maintenance/training/reboot drain
 *   tenants[].declared.tenant          the slice this tenant holds there
 *   tenants[].state                    the slice's kernel ceilings verified (`guaranteed`)
 *   tenants[].until                    set = the slice is being released, unless
 *   tenants[].shrinkTo                 is beside it: a shrink keeps serving, just smaller
 *   tenants[].observed.agent           the process tree shows the tenant listening
 *   tenants[].observed.portReach.controller   the port answered a connect (agent kind)
 * Never `ok`: that also carries CI-only findings (claw-10 read `ok: false` on a
 * `ci-user-drift` finding while its cardtable slice served normally).
 *
 * "Could not look" is `unknown`, never `usable`.
 */

import { endingSlice } from './hosting-slice.js';

/** Drains that take a node out of service. `lease` and `hosting` are a tenant's own holds. */
const OUT_OF_SERVICE_DRAINS = new Set(['maintenance', 'training', 'reboot']);

/** One `tenants[]` entry of a node-status row: a slice and what was observed of it. */
export interface UsableSlice {
	state?: string;
	until?: string | null;
	/** A shrink, not an end: the slice serves at full size until `until`, then at this. */
	shrinkTo?: { memoryMb: number; cores: number } | null;
	declared?: { tenant?: string; role?: string };
	observed?: {
		agent?: string | null;
		portReach?: { controller?: Record<string, string> | null } | null;
	} | null;
}

/** The parts of a `fleet node-status --json` node row this reads. */
export interface UsableNodeRow {
	node: string;
	reachable: boolean;
	drain?: { kind?: string } | null;
	tenants?: UsableSlice[] | null;
}

export type UsableVerdict = 'usable' | 'unusable' | 'unknown';

export interface TenantUsable {
	node: string;
	verdict: UsableVerdict;
	why: string;
	/** The slice's role when it is a standby; absent = the primary. */
	role?: string;
}

export interface TenantBackstop {
	app: string;
	/**
	 * true = hokon takes new work for this tenant now. null = the fleet could
	 * not read where the tenant's slices are, so it cannot decide: keep the
	 * last decision and say so.
	 */
	promote: boolean | null;
	why: string;
	usable: string[];
	unknown: string[];
	nodes: TenantUsable[];
}

/** The verdict for one node that holds a slice of `app`, or null when it holds none. */
export function tenantUsableOn(row: UsableNodeRow, app: string): TenantUsable | null {
	const slice = (row.tenants ?? []).find((t) => t.declared?.tenant === app);
	if (!slice) return null;
	const role = slice.declared?.role;
	const out = (verdict: UsableVerdict, why: string): TenantUsable => ({
		node: row.node,
		verdict,
		why,
		...(role ? { role } : {}),
	});
	if (!row.reachable) return out('unknown', 'the controller could not reach the node');
	const drain = row.drain?.kind;
	if (drain && OUT_OF_SERVICE_DRAINS.has(drain))
		return out('unusable', `the node is under a ${drain} drain`);
	if (endingSlice(slice))
		return out('unusable', `the slice is being released (until ${slice.until})`);
	if (slice.state !== 'guaranteed')
		return out(
			'unusable',
			`the slice is ${slice.state ?? 'in an unrecorded state'}, not guaranteed`
		);
	const obs = slice.observed;
	if (!obs) return out('unknown', 'the slice was not observed');
	if (obs.agent !== 'listening')
		return out('unusable', `the tenant is ${obs.agent ?? 'not observed listening'}`);
	const reach = obs.portReach?.controller;
	if (obs.portReach && !reach)
		return out('unknown', 'the port probe from the controller has no answer');
	if (reach && !Object.values(reach).includes('open'))
		return out('unusable', 'its port answered no connect from the controller');
	return out('usable', 'guaranteed, listening' + (reach ? ', port open' : ''));
}

/**
 * hokon steps in for `app` exactly when no claw holding a slice of it is
 * usable. `unreadable` names why the slice records could not be read: every
 * row's `tenants` is then empty for want of looking, not for want of slices.
 */
export function judgeTenantBackstop(
	rows: UsableNodeRow[],
	app: string,
	unreadable: string | null = null
): TenantBackstop {
	if (unreadable)
		return {
			app,
			promote: null,
			why: `could not look: ${unreadable}`,
			usable: [],
			unknown: [],
			nodes: [],
		};
	const nodes = rows.flatMap((r) => tenantUsableOn(r, app) ?? []);
	const usable = nodes.filter((n) => n.verdict === 'usable').map((n) => n.node);
	const unknown = nodes.filter((n) => n.verdict === 'unknown').map((n) => n.node);
	const why =
		nodes.length === 0
			? 'no claw holds a slice of it'
			: usable.length > 0
				? `${usable.length} of ${nodes.length} claws usable (${usable.join(', ')})`
				: `none of ${nodes.length} claws usable` +
					(unknown.length ? `; could not look at ${unknown.join(', ')}` : '');
	return { app, promote: usable.length === 0, why, usable, unknown, nodes };
}
