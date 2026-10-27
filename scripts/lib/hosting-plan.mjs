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
 *   - every `placement.require` rule holds.
 *
 * `isolation.ciMayRead: false` is ADVISORY until {@link STRICT_AFTER_CUT_OVER}
 * candidates are cut over to their own CI user, and a filter from then on
 * (cardtable's ruling: a filter today would take away its base claw). Until
 * then a not-cut-over claw is still offered, ranked after every cut-over one,
 * and carries the risk in words.
 *
 * RANK among the claws that fit: cut over first, then the fewest CI jobs
 * lost, then the most memory left.
 */
import { ciJobsAfter } from './hosting-offers.mjs';

/** How many fitting, cut-over claws make `ciMayRead: false` a filter instead of a preference. */
export const STRICT_AFTER_CUT_OVER = 3;

const LINK_RULE = { wired: (o) => (o.link === null ? null : o.link === 'wired') };

/** Does a node satisfy one placement rule? true / false / null (could not tell). */
function ruleHolds(rule, offer) {
	if (rule in LINK_RULE) return LINK_RULE[rule](offer);
	if (rule === 'not-beside-unbounded') return offer.pm2.unbounded.length === 0;
	if (rule === 'pm2-peer') return offer.pm2Peer;
	if (rule === 'low-reboot-churn') return true; // a preference with no data behind it yet; never refuses
	const gpu = /^gpu:(.+)$/.exec(rule);
	if (gpu) return offer.gpu.includes(gpu[1]);
	const notWith = /^not-with:(.+)$/.exec(rule);
	if (notWith) return !offer.tenants.some((t) => t.tenant === notWith[1]);
	return null;
}

/** Plan `request` (a NORMALIZED hosting request) against `offers` (from collectOffers). */
export function planFor(request, offers) {
	const { app, slices, disk, placement, isolation } = request;
	const held = offers.filter((o) => o.reachable && o.tenants.some((t) => t.tenant === app));
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
	const strict = !isolation.ciMayRead && cutOverFitting >= STRICT_AFTER_CUT_OVER;
	for (const r of fitting) {
		if (isolation.ciMayRead || r.cutOver) continue;
		if (strict) {
			r.fits = false;
			r.reasons.push(`CI here is not cut over to its own user, and ${app} may not be read by CI`);
		} else {
			r.risk = `CI here still runs with sudo, so a job could read ${app}; offered because fewer than ${STRICT_AFTER_CUT_OVER} candidates are cut over`;
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
	};
}
