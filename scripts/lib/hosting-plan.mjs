/**
 * THE PLAN: a hosting request against every claw's offer. The third part of
 * the hosting layer (docs/planning/hosting-layer-2026-10-27.md §2).
 *
 * It answers ONE question: which claws could lend this tenant its next slice,
 * ranked, each with its reasons and its cost to CI. It recommends and does
 * nothing. Placement INSIDE a slice, and when to ask for one, are the
 * tenant's (agreed with cardtable, 2026-10-27); the operator approves every
 * declaration.
 *
 * HARD RULES, every one a reason when it refuses:
 *   - the tenant is not already at `slices.max`;
 *   - one slice of a tenant per node;
 *   - the node answered, and is not drained or leased;
 *   - the unit fits the offer: memory, cores, and disk for `stateGb`;
 *   - every `placement.require` rule holds;
 *   - the node runs what `runtime` names: node in its range and every tool,
 *     executed on the service's PATH (lib/hosting-offers.mjs).
 *
 * `isolation.ciMayRead: false` is ADVISORY until `isolation.advisoryUntil`
 * fitting candidates are cut over to their own CI user, and a filter from
 * then on. The number is the tenant's (lib/hosting-request.mjs): cardtable
 * keeps 3, a tenant that must never sit beside root CI says 0. Until then a
 * not-cut-over claw is still offered, ranked after every cut-over one, and
 * carries the risk in words.
 *
 * Placement rules are lib/hosting-placement.mjs's; this file only applies them.
 *
 * RANK among the claws that fit: cut over first, then the fewest CI jobs
 * lost, then the most memory left.
 *
 * STANDBYS (`availability.standby`, docs/service-state.md) are planned as their
 * own entry. A slice whose record says `role: "standby"` is not one of the
 * primary's `held`, so it never counts toward `slices.max` or as a second
 * writer. A standby candidate passes every rule above, `runtime` included, or
 * a failover would land where the app cannot run, and it is never the node the
 * primary holds or is about to be given.
 */
import { ciJobsAfter } from './hosting-offers.mjs';
import { ruleHolds } from './hosting-placement.mjs';
import { ADVISORY_UNTIL_DEFAULT } from './hosting-request.mjs';
import { satisfies } from './tool-release.mjs';

/** Plan `request` (a NORMALIZED hosting request) against `offers` (from collectOffers). */
export function planFor(request, offers) {
	const { app, slices, disk, placement, isolation } = request;
	const holds = (o, standby) =>
		o.reachable && o.tenants.some((t) => t.tenant === app && (t.role === 'standby') === standby);
	const held = offers.filter((o) => holds(o, false));
	const atMax = held.length >= slices.max;

	const rows = offers.map((o) => {
		const no = [];
		if (!o.reachable) {
			no.push(o.expectedDown ? 'expected down' : `did not answer (${o.unknown.join('; ')})`);
			return { node: o.node, fits: false, reasons: no };
		}
		if (o.tenants.some((t) => t.tenant === app)) no.push(`already holds a ${app} slice`);
		if (o.drain)
			no.push(`drained (${o.drain.kind})${o.drain.until ? ` until ${o.drain.until}` : ''}`);
		const h = o.hostable;
		const need = slices.unit;
		if (h.memoryMb === null) no.push(`hostable memory unknown: ${o.unknown.join('; ')}`);
		else if (h.memoryMb < need.memoryMb)
			no.push(`offers ${h.memoryMb} MiB, the unit needs ${need.memoryMb}`);
		if (h.cores === null) no.push('core count unknown');
		else if (h.cores < need.cores) no.push(`offers ${h.cores} cores, the unit needs ${need.cores}`);
		if (h.diskFreeGb === null) no.push('free disk unknown');
		else if (h.diskFreeGb < disk.stateGb)
			no.push(`${h.diskFreeGb} GB free, state needs ${disk.stateGb}`);
		const want = request.runtime ?? {};
		if (want.node) {
			const v = o.runtime?.node;
			if (v === undefined) no.push('node version unknown');
			else if (v === null) no.push('no node on the service PATH');
			else if (!satisfies(v, want.node)) no.push(`node ${v} does not satisfy ${want.node}`);
		}
		for (const t of want.tools ?? []) {
			const ran = o.runtime?.tools?.[t];
			if (ran === undefined) no.push(`whether ${t} runs is unknown`);
			else if (!ran) no.push(`${t} does not run on the service PATH`);
		}
		for (const rule of placement.require) {
			const holds = ruleHolds(rule, o);
			if (holds === false) no.push(`fails "${rule}"`);
			else if (holds === null) no.push(`cannot tell whether "${rule}" holds`);
		}
		const before = ciJobsAfter(o, 0);
		const after = ciJobsAfter(o, need.memoryMb);
		return {
			node: o.node,
			fits: no.length === 0,
			reasons: no,
			cutOver: o.ci.cutOver,
			ciJobs: { before, after },
			memoryLeftMb: h.memoryMb === null ? null : h.memoryMb - need.memoryMb,
		};
	});

	const fitting = rows.filter((r) => r.fits);
	const cutOverFitting = fitting.filter((r) => r.cutOver).length;
	// A request stored before the field existed has none: it means the default, never "no bar".
	const advisoryUntil = isolation.advisoryUntil ?? ADVISORY_UNTIL_DEFAULT;
	const strict = !isolation.ciMayRead && cutOverFitting >= advisoryUntil;
	for (const r of fitting) {
		if (isolation.ciMayRead || r.cutOver) continue;
		if (strict) {
			r.fits = false;
			r.reasons.push(`CI here is not cut over to its own user, and ${app} may not be read by CI`);
		} else {
			r.risk = `CI here still runs with sudo, so a job could read ${app}; offered because fewer than ${advisoryUntil} candidates are cut over`;
		}
	}

	const lost = (r) => (r.ciJobs.before ?? 0) - (r.ciJobs.after ?? 0);
	const ranked = rows
		.filter((r) => r.fits)
		.sort(
			(a, b) =>
				Number(b.cutOver) - Number(a.cutOver) ||
				lost(a) - lost(b) ||
				(b.memoryLeftMb ?? 0) - (a.memoryLeftMb ?? 0)
		);
	return {
		app,
		held: held.map((o) => o.node),
		atMax,
		ciMayReadPolicy: isolation.ciMayRead ? 'not asked' : strict ? 'filter' : 'advisory',
		ranked: atMax ? [] : ranked,
		refused: rows.filter((r) => !r.fits),
		...standbyPlan(request, offers, holds, ranked, atMax),
	};
}

/**
 * The standby entry, only for a request that asks for one. `ranked` already
 * excludes every node holding a slice of the app, primary or standby. While no
 * primary is held, the primary's pick is ranked[0], so a standby starts after it.
 */
function standbyPlan(request, offers, holds, ranked, atMax) {
	const wanted = request.availability.standby ?? 0;
	if (!wanted) return {};
	const held = offers.filter((o) => holds(o, true)).map((o) => o.node);
	const candidates = (atMax ? ranked : ranked.slice(1)).map((r) => ({ ...r, role: 'standby' }));
	const need = Math.max(0, wanted - held.length);
	return {
		standby: {
			wanted,
			held,
			ranked: need ? candidates : [],
			...(candidates.length < need
				? {
						short: `${wanted} standby wanted, ${held.length} held, and only ${candidates.length} other node(s) fit`,
					}
				: {}),
		},
	};
}
