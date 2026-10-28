/**
 * THE HOSTING CONVERGER'S DECISION: a tenant's demand against what it holds.
 * fleet-manager#16; design in docs/planning/capability-placement-2026-10-28.md §3.
 *
 * PURE. It takes the plan (`planFor`, which owns every placement rule), the
 * offers and the records, and returns what to do. Nothing here ranks a node
 * or restates a rule. The subcommand (scripts/hosting-converge.mjs) does the
 * acts through the `fleet hosting` door, which checks fit and the tenant's
 * own placement again at the moment of each declare.
 *
 * desired   = demand, else slices.min, clamped to min..max.
 * held      = slices declared and not past their end.
 * ending    = held, with an end scheduled. Not counted as serving.
 * unplaceable = held, on a node that is unreachable, fails a required rule,
 *             or has a drain of another kind starting within the notice
 *             horizon. A rule that cannot be told (null) is NOT a fault.
 * serving   = held − ending − unplaceable.
 *
 * TOO FEW: declare on the plan's top picks, one slice per node, never past
 * `max`. A SINGLETON whose one slice is unplaceable needs a MOVE, which is
 * the mover's (hadoku_site#491) and is not done here. It is blocked, and the
 * block says why. A singleton on a node that cannot be reached and has no
 * fence is never moved: two writers is worse than none.
 * TOO MANY: end from the head of the tenant's releaseOrder, with notice. With
 * no order, end nothing and say so.
 * PAST ITS END: remove the units.
 *
 * Unplaceable slices are never ended here. The tenant moves its work off them
 * (it reads the same notices) and names them in its release order.
 */
import { ruleHolds } from './hosting-placement.mjs';

/** A drain of another kind starting this long past the tenant's notice counts as now. */
export const HORIZON_MARGIN_MS = 15 * 60_000;

/**
 * @param {object} i
 * @param {object} i.request   normalized hosting request
 * @param {object|null} i.demand  `{ slices, releaseOrder }` or null
 * @param {object} i.plan      planFor(request, offers)
 * @param {object} [i.movePlan] planFor with max + 1, for a singleton: a move is not a second slice
 * @param {object[]} i.offers  collectOffers().offers
 * @param {{node:string, until?:string}[]} i.slices  this tenant's records, in force
 * @param {string[]} i.removeDue  nodes whose slice end has passed and still has units
 * @param {object[]} i.notices drainNotices + hostingNotices
 * @param {number} i.now
 */
export function decide({
	request,
	demand,
	plan,
	movePlan,
	offers,
	slices,
	removeDue,
	notices,
	now,
}) {
	const { app, slices: size, availability, placement } = request;
	const desired = Math.min(size.max, Math.max(size.min, demand?.slices ?? size.min));
	const horizonMs = availability.noticeMin * 60_000 + HORIZON_MARGIN_MS;
	const offerOf = new Map(offers.map((o) => [o.node, o]));

	const ending = slices.filter((s) => s.until).map((s) => ({ node: s.node, until: s.until }));
	const unplaceable = [];
	for (const s of slices.filter((x) => !x.until)) {
		const why = faultOf(s.node, offerOf.get(s.node), placement.require, notices, now, horizonMs);
		if (why)
			unplaceable.push({ node: s.node, why, reachable: offerOf.get(s.node)?.reachable === true });
	}
	const bad = new Set(unplaceable.map((u) => u.node));
	const serving = slices.filter((s) => !s.until && !bad.has(s.node)).map((s) => s.node);

	const actions = removeDue.map((node) => ({ op: 'remove', node, why: 'its end has passed' }));
	const blocked = [];

	if (serving.length < desired) {
		if (availability.singleton && slices.length > 0) {
			for (const u of unplaceable) {
				const target = movePlan?.ranked[0]?.node ?? null;
				blocked.push({
					node: u.node,
					why:
						!u.reachable && availability.fence !== 'data-lease'
							? `${u.node} cannot be reached and ${app} has no fence: never moved off, ` +
								'because a second writer is worse than none'
							: `${u.node} ${u.why}; a singleton moves through the mover (hadoku_site#491), ` +
								`not a second slice${target ? `. The plan's next node is ${target}` : ''}`,
				});
			}
		} else {
			const room = size.max - slices.length;
			const want = Math.min(desired - serving.length, room);
			const picks = plan.ranked.slice(0, Math.max(0, want));
			for (const r of picks)
				actions.push({
					op: 'declare',
					node: r.node,
					why: `${serving.length} serving of ${desired} wanted`,
				});
			if (picks.length < desired - serving.length)
				blocked.push({
					node: '*',
					why:
						room < desired - serving.length
							? `${app} holds ${slices.length} of its ${size.max} slices and ${unplaceable.length} cannot serve`
							: `${desired} wanted, ${serving.length} serving, and only ${picks.length} more node(s) fit: ` +
								summarizeRefused(plan.refused),
				});
		}
	} else if (serving.length > desired) {
		const excess = serving.length - desired;
		const order = (demand?.releaseOrder ?? []).filter((n) => serving.includes(n));
		for (const node of order.slice(0, excess))
			actions.push({
				op: 'end',
				node,
				inMin: availability.noticeMin,
				why: `${serving.length} serving, ${desired} wanted; first in ${app}'s release order`,
			});
		if (order.length < excess)
			blocked.push({
				node: '*',
				why:
					`${excess} slice(s) above demand and the release order names ${order.length} serving ` +
					`one(s); nothing else is ended, because only ${app} knows what each slice holds`,
				soft: true,
			});
	}

	return { app, desired, serving, ending, unplaceable, actions, blocked };
}

/** Why a held slice's node cannot serve, or null. */
function faultOf(node, offer, require, notices, now, horizonMs) {
	if (!offer?.reachable) return 'cannot be reached';
	for (const rule of require) if (ruleHolds(rule, offer) === false) return `fails "${rule}"`;
	const soon = notices.find(
		(n) =>
			n.node === node &&
			n.event === 'starts' &&
			n.kind !== 'hosting' &&
			n.kind !== 'lease' &&
			Date.parse(n.at) - now <= horizonMs
	);
	return soon ? `has a ${soon.kind} drain starting ${soon.at}` : null;
}

function summarizeRefused(refused) {
	return refused.map((r) => `${r.node}: ${r.reasons.join(', ')}`).join('; ');
}

/** The `fleet hosting` arguments for one action. The door re-checks fit and placement on a declare. */
export function doorArgs(request, a) {
	const reason = ['--reason', `hosting-converge: ${a.why}`];
	if (a.op === 'declare') {
		const { memoryMb, cores } = request.slices.unit;
		return [
			a.node,
			'--tenant',
			request.app,
			'--memory',
			`${memoryMb}M`,
			'--cores',
			String(cores),
			'--shared',
			...reason,
		];
	}
	if (a.op === 'end') return [a.node, '--end', '--in', `${a.inMin}m`, ...reason];
	return [a.node, '--remove'];
}

/**
 * Turn one tenant's decision into converge rows, acting through `door` when
 * `live`. `door(args)` resolves `{ doc, why }`: the hosting door's `--json`, or
 * null and the reason it gave none. Not live, every action and block is
 * `planned`: what the converger WOULD do, for the tenant to compare.
 *
 *   converged + changed   the door did it and says so (`ok`)
 *   deferred              a declare the door accepted that is not guaranteed
 *                         yet (an agent the tenant has not installed). Pages
 *                         only if it stays, by the converger's clock
 *   unconverged           the door refused or failed, or a hard block: pages
 */
export async function act(request, decision, { live, door }) {
	const facet = `hosting:${request.app}`;
	const rows = { planned: [], converged: [], deferred: [], unconverged: [], changed: [] };
	const results = [];
	for (const a of decision.actions) {
		const row = { node: a.node, facet, before: a.why, op: a.op };
		if (!live) {
			rows.planned.push({ ...row, changed: `would ${a.op}` });
			continue;
		}
		const { doc, why } = await door(doorArgs(request, a));
		results.push({
			...a,
			ok: doc?.ok ?? false,
			state: doc?.state ?? null,
			reason: doc?.reason ?? why,
		});
		if (doc?.ok) {
			const changed =
				a.op === 'end' ? `ends ${doc.until ?? `in ${a.inMin} min`}` : `${a.op}d (${doc.state})`;
			rows.converged.push({ ...row, changed });
			rows.changed.push({ node: a.node, facet, changed });
		} else if (a.op === 'declare' && doc?.state === 'not-guaranteed') {
			rows.deferred.push({ ...row, why: doc.reason ?? 'declared, not guaranteed yet' });
			rows.changed.push({ node: a.node, facet, changed: 'declared, not guaranteed yet' });
		} else {
			rows.unconverged.push({
				...row,
				why: doc?.reason ?? why ?? 'the hosting door gave no answer',
			});
		}
	}
	for (const b of decision.blocked) {
		const row = { node: b.node, facet, why: b.why };
		if (live && !b.soft) rows.unconverged.push(row);
		else rows.planned.push({ ...row, changed: 'blocked' });
	}
	return { rows, results };
}
