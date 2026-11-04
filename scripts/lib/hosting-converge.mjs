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
 * UNITS AND CLAWS ARE TWO NUMBERS (operator, 2026-11-04). A unit is
 * capacity, `slices.unit`; a claw is a failure domain. One claw holds one
 * slice of a tenant, k units big, and k follows what the claw can lend: a
 * strong claw takes several, a weaker one may hold its one.
 *
 * demanded  = demand, else slices.min, clamped to min..max. In UNITS.
 * minNodes  = the spread floor: `spread.minNodes`, else FLEET_MIN_NODES
 *             (lib/hosting-request.mjs `nodesWanted`). In CLAWS.
 * desired   = max(demanded, minNodes), never past max: each claw holds a unit.
 * held      = slices declared and not past their end.
 * ending    = held, with an end scheduled. Not counted as serving.
 * shrinking = held, with an end that carries `shrinkTo`: it serves until the
 *             end at its full size, is counted at the smaller one, and is
 *             re-declared at it once the notice has run (op `resize`).
 * unplaceable = held, on a node that is unreachable, fails a required rule,
 *             or has a drain of another kind starting within the notice
 *             horizon. A rule that cannot be told (null) is NOT a fault.
 * serving   = held − ending − unplaceable.
 *
 * THE REBOOT CYCLE'S OWN REBOOT IS NOT A FAULT. Its notice (a `reboot` drain
 * whose reason carries the cycle's REASON_PREFIX) does not make the node
 * unplaceable, and neither does the box being down while `rebooting` names it:
 * the subcommand builds that set from the cycle's in-flight record, bounded by
 * the cycle's own boot and services timeouts, so a reboot that fails
 * verification, or a cycle that died mid-reboot, is a fault again at the moment
 * the cycle itself would hold the node. On 2026-11-03 claw-8's 15 min notice
 * and 56 s of downtime made the converger declare claw-5 at 21:38, end it at
 * 21:52 and remove it at 22:12, while cardtable's demand never moved off 2.
 * A `reboot` drain anyone else writes is still a fault.
 *
 * TOO FEW, AND ONE OF ITS OWN IS ENDING: take the end back (`--keep`) before
 * declaring anywhere new, latest in the release order first. That includes a
 * slice past its end whose units are still there: demand that came back
 * between one pass and the next must not cost the tenant its node. On
 * 2026-10-28 cardtable went 2 → 1 → 2 within 14 min; the converger removed
 * claw-9 36 s past its end and declared claw-5 beside it to make up the count.
 * TOO FEW (claws under minNodes, or units under desired): a unit on each new
 * claw from the plan's top picks until the floor is met, then each further
 * unit to the best-ranked claw with room, held (`resize`) or new (`declare`),
 * never past `max` units (`allocate`). A SINGLETON whose one slice is unplaceable needs a MOVE, which is
 * the mover's (hadoku_site#491) and is not done here. It is blocked, and the
 * block says why. A singleton on a node that cannot be reached and has no
 * fence is never moved: two writers is worse than none.
 * TOO MANY UNITS: from the head of the tenant's releaseOrder, with notice,
 * end a whole claw while more than minNodes would remain and it holds no more
 * than the excess; else shrink it toward one unit. With no order, end
 * nothing and say so. While any slice it holds is younger than
 * YOUNG_SLICE_MS, end nothing: the tenant has not judged that node yet, and
 * cardtable puts a claw it has not canaried at the HEAD of its order. On
 * 2026-10-29 claw-9 was re-declared and read [claw-9, claw-5, claw-8] for 81 s;
 * a pass in that window would have ended the node just given back.
 * PAST ITS END: remove the units.
 *
 * Unplaceable slices are never ended here. The tenant moves its work off them
 * (it reads the same notices) and names them in its release order.
 *
 * STANDBYS (`availability.standby`, docs/service-state.md) are counted apart:
 * a slice with `role: "standby"` is never serving, never in `held`, and never
 * a second writer. They are met from the plan's own `standby` entry (every
 * primary rule, runtime included, never the primary's node) and only beside a
 * primary held in this layer: a standby of nothing is a second instance. One
 * past the count is ended with the tenant's notice; it holds no authority, so
 * no release order is needed. An unplaceable standby is replaced, not ended.
 */
import { requiredRules, ruleDetail, ruleHoldsHeld } from './hosting-placement.mjs';
import { nodesWanted, unitsOf } from './hosting-request.mjs';
import { REASON_PREFIX } from './reboot-hold.mjs';
import { endingSlice } from '../../dist/lib/hosting-slice.js';

/** A drain of another kind starting this long past the tenant's notice counts as now. */
export const HORIZON_MARGIN_MS = 15 * 60_000;

/** A slice declared this recently is not yet in the tenant's release order on its merits. */
export const YOUNG_SLICE_MS = 10 * 60_000;

/**
 * @param {object} i
 * @param {object} i.request   normalized hosting request
 * @param {object|null} i.demand  `{ slices, releaseOrder }` or null
 * @param {object} i.plan      planFor(request, offers)
 * @param {object} [i.movePlan] planFor with max + 1, for a singleton: a move is not a second slice
 * @param {object[]} i.offers  collectOffers().offers
 * @param {{node:string, until?:string, since?:string}[]} i.slices  this tenant's records, in force
 * @param {string[]} i.removeDue  nodes whose slice end has passed and still has units
 * @param {string[]} [i.pastEnd]  the primaries among removeDue: what `--keep` may take back
 * @param {object[]} i.notices drainNotices + hostingNotices
 * @param {Set<string>} [i.rebooting] nodes the reboot cycle is rebooting now, inside its own
 *        timeouts (`cycleRebooting`): their being down is not a fault
 * @param {{node: string|null}|{unreadable: string}} [i.appLayer] for a service:
 *        where hadoku_site runs it now (appLayerHost), or why that could not be read
 * @param {{from: string, to: string, epoch: number}|null} [i.move] a singleton's open
 *        move, from the hosting record (`fleet hosting --move`)
 * @param {number} i.now
 */
export function decide({
	request,
	demand,
	plan,
	movePlan,
	offers,
	slices: allSlices,
	removeDue,
	pastEnd = [],
	notices,
	rebooting = new Set(),
	now,
	appLayer = null,
	move = null,
}) {
	const { app, slices: size, availability } = request;
	// TWO NUMBERS: units (capacity, the demand) and claws (failure domains,
	// the spread floor). Every claw holds at least one unit, so the units
	// wanted are never fewer than the claws wanted.
	const demanded = Math.min(size.max, Math.max(size.min, demand?.slices ?? size.min));
	const minNodes = nodesWanted(request);
	const desired = Math.min(size.max, Math.max(demanded, minNodes));
	const horizonMs = availability.noticeMin * 60_000 + HORIZON_MARGIN_MS;
	const offerOf = new Map(offers.map((o) => [o.node, o]));
	const fault = (node) =>
		faultOf(node, offerOf.get(node), requiredRules(request), notices, rebooting, now, horizonMs);
	// A slice is k units. One that is SHRINKING (an end with `shrinkTo`) serves
	// until its end, and is counted at the size it is going to.
	const fullUnits = (s) => unitsOf(request, s.memoryMb);
	const unitsAt = (s) => unitsOf(request, s.shrinkTo?.memoryMb ?? s.memoryMb);
	const ends = endingSlice;

	const primaries = allSlices.filter((s) => s.role !== 'standby');
	const liveSlices = primaries.filter((s) => !ends(s) && !fault(s.node));
	let liveNodes = liveSlices.length;
	let liveUnits = liveSlices.reduce((n, s) => n + unitsAt(s), 0);
	const rank = (node) => {
		const i = (demand?.releaseOrder ?? []).indexOf(node);
		return i === -1 ? Infinity : i;
	};
	// A SINGLETON never gets an ended slice back while another primary is in
	// force: after a committed move the old node's copy is stopped and its
	// state is gone, so keeping it would name two places that may run it.
	const otherInForce = availability.singleton && primaries.some((s) => !s.until);
	const keeps = [];
	if (!otherInForce) {
		const candidates = [
			...primaries.filter((s) => s.until),
			// Past its end and out of force: an end, never a shrink (the subcommand keeps those out).
			...pastEnd
				.filter((n) => !primaries.some((s) => s.node === n))
				.map((node) => ({ node, until: 'passed' })),
		]
			.filter((s) => !fault(s.node))
			.sort((a, b) => rank(b.node) - rank(a.node));
		for (const s of candidates) {
			if (liveNodes >= minNodes && liveUnits >= desired) break;
			keeps.push(s.node);
			// Keeping an end brings the claw back; keeping a shrink, the units it was giving up.
			if (ends(s)) liveNodes++;
			liveUnits += ends(s) ? fullUnits(s) : fullUnits(s) - unitsAt(s);
		}
	}
	const kept = new Set(keeps);
	const slices = [
		...primaries.map(({ until, shrinkTo, ...s }) =>
			kept.has(s.node)
				? s
				: { ...s, ...(until ? { until } : {}), ...(shrinkTo ? { shrinkTo } : {}) }
		),
		...keeps.filter((n) => !primaries.some((s) => s.node === n)).map((node) => ({ node })),
	];
	const standbySlices = allSlices.filter((s) => s.role === 'standby');

	const ending = slices.filter(ends).map((s) => ({ node: s.node, until: s.until }));
	const shrinking = slices
		.filter((s) => s.shrinkTo)
		.map((s) => ({ node: s.node, until: s.until, units: unitsAt(s) }));
	const unplaceable = [];
	for (const s of slices.filter((x) => !ends(x))) {
		const why = fault(s.node);
		if (why)
			unplaceable.push({ node: s.node, why, reachable: offerOf.get(s.node)?.reachable === true });
	}
	const bad = new Set(unplaceable.map((u) => u.node));
	const servingSlices = slices.filter((s) => !ends(s) && !bad.has(s.node));
	const serving = servingSlices.map((s) => s.node);
	const unitsOn = new Map(servingSlices.map((s) => [s.node, unitsAt(s)]));
	const servingUnits = [...unitsOn.values()].reduce((a, b) => a + b, 0);
	const wanted = `${desired} unit(s) on at least ${minNodes} claw(s)`;
	const have = `${servingUnits} unit(s) on ${serving.length} claw(s) serving`;

	const actions = [
		...keeps.map((node) => ({
			op: 'keep',
			node,
			why: `${liveSlices.length} serving of ${wanted}; its own slice is kept, not replaced`,
		})),
		...removeDue
			.filter((node) => !kept.has(node))
			.map((node) => ({ op: 'remove', node, why: 'its end has passed' })),
		// A SHRINK WHOSE NOTICE HAS RUN is a re-declare at the smaller size.
		...slices
			.filter((s) => s.shrinkTo && Date.parse(s.until) <= now)
			.map((s) => ({ op: 'resize', node: s.node, units: unitsAt(s), why: 'its shrink is due' })),
	];
	const blocked = [];
	const short = serving.length < minNodes || servingUnits < desired;

	// A SERVICE THE APP LAYER ALREADY RUNS is adopted by a move, never declared
	// beside itself: no slice is not "not running". Could not look is the same block.
	const runningAt =
		request.kind === 'service' && slices.length === 0 && appLayer
			? (appLayer.unreadable ?? null)
			: null;
	const adoptFrom =
		request.kind === 'service' && slices.length === 0 && appLayer?.node ? appLayer.node : null;

	if (availability.singleton && move) {
		// AN OPEN MOVE IS THE MOVER'S: two primaries are expected until it
		// commits, so nothing is declared, ended or kept around it here.
		blocked.push({
			node: move.to,
			why:
				`a move of ${app} is open, ${move.from} → ${move.to} (epoch ${move.epoch}); ` +
				`the mover commits it by ending ${move.from}'s slice`,
			soft: true,
		});
	} else if (short && (adoptFrom || runningAt)) {
		const target = plan.ranked[0]?.node ?? null;
		blocked.push({
			node: adoptFrom ?? '*',
			why: adoptFrom
				? `${app} runs on ${adoptFrom} under the app layer, outside the hosting layer; its first ` +
					`slice is a move (the app layer's service-move), not a declare beside it` +
					(target ? `. The plan's node is ${target}` : '')
				: `where the app layer runs ${app} could not be read (${runningAt}); nothing is declared ` +
					'beside an instance that may be running',
		});
	} else if (short) {
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
			const held = slices.reduce((n, s) => n + (ends(s) ? fullUnits(s) : unitsAt(s)), 0);
			const grown = allocate({
				request,
				plan,
				offerOf,
				slices,
				unitsOn,
				minNodes,
				desired,
				budget: size.max - held,
			});
			for (const g of grown.picks)
				actions.push({
					op: unitsOn.has(g.node) ? 'resize' : 'declare',
					node: g.node,
					units: g.units,
					why: `${have}; ${wanted}`,
				});
			if (grown.nodes < minNodes || grown.units < desired)
				blocked.push({
					node: '*',
					why: grown.atMax
						? `${app} holds ${held} of its ${size.max} units and ${unplaceable.length} cannot serve`
						: `${wanted}, ${grown.units} on ${grown.nodes} claw(s) after this pass, and no claw has room ` +
							`for another: ${summarizeRefused(plan.refused)}`,
				});
		}
	} else if (servingUnits > desired) {
		const excess = servingUnits - desired;
		const young = slices
			.filter((s) => !s.until && now - Date.parse(s.since ?? '') < YOUNG_SLICE_MS)
			.map((s) => s.node);
		if (young.length) {
			blocked.push({
				node: '*',
				why:
					`${excess} unit(s) above demand, and ${young.join(', ')} was declared under ` +
					`${YOUNG_SLICE_MS / 60_000} min ago: nothing is ended until ${app} has judged it`,
				soft: true,
			});
		} else {
			// From the head of the tenant's release order: a whole claw while
			// more than the floor would remain and it holds no more than the
			// excess, else its units down to one. Both with the tenant's notice.
			const order = (demand?.releaseOrder ?? []).filter(
				(n) => unitsOn.has(n) && !slices.find((s) => s.node === n).shrinkTo
			);
			let left = excess;
			let nodesLeft = serving.length;
			for (const node of order) {
				if (left <= 0) break;
				const u = unitsOn.get(node);
				if (nodesLeft > minNodes && u <= left) {
					actions.push({
						op: 'end',
						node,
						inMin: availability.noticeMin,
						why: `${have}, ${wanted}; first in ${app}'s release order`,
					});
					left -= u;
					nodesLeft--;
				} else if (u > 1) {
					const to = u - Math.min(u - 1, left);
					actions.push({
						op: 'shrink',
						node,
						units: to,
						inMin: availability.noticeMin,
						why: `${have}, ${wanted}; ${node} goes from ${u} to ${to} unit(s)`,
					});
					left -= u - to;
				}
			}
			if (left > 0)
				blocked.push({
					node: '*',
					why:
						`${left} unit(s) above demand and ${app}'s release order names no serving claw that ` +
						`can give them up without going under ${minNodes} claw(s); nothing else is ended, ` +
						`because only ${app} knows what each slice holds`,
					soft: true,
				});
		}
	}

	const standby = meetStandby({
		request,
		plan,
		standbySlices,
		primaryHeld: slices.filter((s) => !ends(s)).length,
		fault,
		offerOf,
		actions,
		blocked,
	});
	return {
		app,
		desired,
		demanded,
		minNodes,
		serving,
		servingUnits,
		ending,
		...(shrinking.length ? { shrinking } : {}),
		unplaceable,
		actions,
		blocked,
		...(standby ? { standby } : {}),
	};
}

/**
 * Where the missing units go, one at a time. First one unit on each new claw
 * until the spread floor is met, in the plan's ranking. Then each further unit
 * to the best claw with room for it, held or new, by the tenant's
 * `placement.order` (a held claw before a new one at the same rank): a strong
 * claw takes several, a weaker one may hold its one. A held claw's room is
 * what its offer still lends (the offer already charges every slice on it); a
 * shrinking one gives, it does not take. `budget`: units left under `max`.
 */
function allocate({ request, plan, offerOf, slices, unitsOn, minNodes, desired, budget }) {
	const { unit } = request.slices;
	const order = request.placement?.order ?? [];
	const orderRank = (n) => (order.includes(n) ? order.indexOf(n) : Infinity);
	const roomOf = (n) => {
		const h = offerOf.get(n)?.hostable;
		if (!Number.isFinite(h?.memoryMb) || !Number.isFinite(h?.cores)) return 0;
		return Math.max(
			0,
			Math.min(Math.floor(h.memoryMb / unit.memoryMb), Math.floor(h.cores / unit.cores))
		);
	};
	const holding = new Set(slices.map((s) => s.node));
	const shrinking = new Set(slices.filter((s) => s.shrinkTo).map((s) => s.node));
	const fresh = plan.ranked.map((r) => r.node).filter((n) => !holding.has(n));
	const add = new Map();
	// A new claw's first unit is the plan's fit; every unit past it is the offer's room.
	const spare = (n) =>
		shrinking.has(n)
			? 0
			: (unitsOn.has(n) ? roomOf(n) : Math.max(1, roomOf(n))) - (add.get(n) ?? 0);
	let nodes = unitsOn.size;
	let units = [...unitsOn.values()].reduce((a, b) => a + b, 0);
	let left = budget;
	let next = 0;
	const take = (n) => {
		add.set(n, (add.get(n) ?? 0) + 1);
		units++;
		left--;
	};
	while (nodes < minNodes && left > 0 && next < fresh.length) {
		take(fresh[next++]);
		nodes++;
	}
	while (units < desired && left > 0) {
		const pool = [...new Set([...unitsOn.keys(), ...add.keys()])].filter((n) => spare(n) > 0);
		const best = pool.sort((a, b) => orderRank(a) - orderRank(b))[0];
		const newcomer = fresh[next];
		if (newcomer !== undefined && (best === undefined || orderRank(newcomer) < orderRank(best))) {
			take(fresh[next++]);
			nodes++;
		} else if (best !== undefined) take(best);
		else break;
	}
	return {
		picks: [...add].map(([node, k]) => ({ node, units: (unitsOn.get(node) ?? 0) + k })),
		nodes,
		units,
		atMax: left <= 0,
	};
}

/** The standby half of a decision; pushes onto `actions`/`blocked`. Null when none is asked or held. */
function meetStandby({
	request,
	plan,
	standbySlices,
	primaryHeld,
	fault,
	offerOf,
	actions,
	blocked,
}) {
	const { app, availability } = request;
	const wanted = availability.standby ?? 0;
	if (!wanted && !standbySlices.length) return null;
	const ending = standbySlices
		.filter((s) => s.until)
		.map((s) => ({ node: s.node, until: s.until }));
	const unplaceable = [];
	for (const s of standbySlices.filter((x) => !x.until)) {
		const why = fault(s.node);
		if (why)
			unplaceable.push({ node: s.node, why, reachable: offerOf.get(s.node)?.reachable === true });
	}
	const bad = new Set(unplaceable.map((u) => u.node));
	const serving = standbySlices.filter((s) => !s.until && !bad.has(s.node)).map((s) => s.node);

	if (serving.length < wanted) {
		if (!primaryHeld) {
			blocked.push({
				node: '*',
				why: `${app} holds no primary slice in the hosting layer, so a standby would stand by for nothing`,
				soft: true,
			});
		} else {
			// Never on a node this pass is already declaring on.
			const taken = new Set(actions.filter((a) => a.op === 'declare').map((a) => a.node));
			const picks = (plan.standby?.ranked ?? [])
				.filter((r) => !taken.has(r.node))
				.slice(0, wanted - serving.length);
			for (const r of picks)
				actions.push({
					op: 'declare',
					role: 'standby',
					node: r.node,
					why: `${serving.length} standby serving of ${wanted} wanted`,
				});
			if (picks.length < wanted - serving.length)
				blocked.push({
					node: '*',
					why:
						`${wanted} standby wanted, ${serving.length} serving, and only ${picks.length} more ` +
						`node(s) fit: ${summarizeRefused(plan.refused)}`,
				});
		}
	} else if (serving.length > wanted) {
		for (const node of serving.slice(wanted))
			actions.push({
				op: 'end',
				role: 'standby',
				node,
				inMin: availability.noticeMin,
				why: `${serving.length} standby serving, ${wanted} wanted`,
			});
	}
	return { wanted, serving, ending, unplaceable };
}

/** The reboot cycle's own notice: it reboots, verifies and lifts, so the node keeps serving. */
const cycleReboot = (n) => n.kind === 'reboot' && String(n.reason ?? '').startsWith(REASON_PREFIX);

/** Why a held slice's node cannot serve, or null. */
function faultOf(node, offer, require, notices, rebooting, now, horizonMs) {
	if (!offer?.reachable) return rebooting.has(node) ? null : 'cannot be reached';
	for (const rule of require) {
		if (ruleHoldsHeld(rule, offer) !== false) continue;
		const seen = ruleDetail(rule, offer);
		return `fails "${rule}"${seen ? `: ${seen}` : ''}`;
	}
	const soon = notices.find(
		(n) =>
			n.node === node &&
			n.event === 'starts' &&
			n.kind !== 'hosting' &&
			n.kind !== 'lease' &&
			!cycleReboot(n) &&
			Date.parse(n.at) - now <= horizonMs
	);
	return soon ? `has a ${soon.kind} drain starting ${soon.at}` : null;
}

/**
 * The refused nodes, worded for an alert. A node on Wi-Fi is left out by name:
 * it never hosts anything that requires `wired`, so listing claw-1..3 under
 * every shortfall read as though they were candidates (operator, 2026-10-31).
 * They are still counted, so a shortfall never hides how many nodes were seen.
 */
function summarizeRefused(refused) {
	const wifi = refused.filter((r) => r.reasons.includes('fails "wired"'));
	const rest = refused.filter((r) => !wifi.includes(r));
	const lines = rest.map((r) => `${r.node}: ${r.reasons.join(', ')}`);
	if (wifi.length) lines.push(`${wifi.length} Wi-Fi node(s) never host it`);
	return lines.join('; ');
}

/**
 * The `fleet hosting` arguments for one action. The door re-checks fit and
 * placement on a declare. Every action names its tenant: a node may hold
 * several, and the door refuses to guess (fleet-manager#32).
 */
export function doorArgs(request, a) {
	const reason = ['--reason', `hosting-converge: ${a.why}`];
	// A slice of k units is one slice of k times the unit; a resize re-declares it.
	const { memoryMb, cores } = request.slices.unit;
	const k = a.units ?? 1;
	const size = ['--memory', `${memoryMb * k}M`, '--cores', String(cores * k)];
	const tenant = ['--tenant', request.app];
	if (a.op === 'declare' || a.op === 'resize')
		return [
			a.node,
			...tenant,
			...size,
			'--shared',
			...(a.role ? ['--role', a.role] : []),
			...reason,
		];
	if (a.op === 'end') return [a.node, ...tenant, '--end', '--in', `${a.inMin}m`, ...reason];
	if (a.op === 'shrink')
		return [a.node, ...tenant, '--end', '--in', `${a.inMin}m`, ...size, ...reason];
	if (a.op === 'keep') return [a.node, ...tenant, '--keep'];
	return [a.node, ...tenant, '--remove'];
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
export async function act(request, decision, { live, door, artifact = null }) {
	const facet = `hosting:${request.app}`;
	const rows = { planned: [], converged: [], deferred: [], unconverged: [], changed: [] };
	const results = [];
	const agent = request.kind === 'agent';
	for (const a of decision.actions) {
		const row = { node: a.node, facet, before: a.why, op: a.op };
		if (!live) {
			rows.planned.push({
				...row,
				changed: `would ${a.op}${a.op === 'declare' && agent ? ' and install the agent' : ''}`,
			});
			continue;
		}
		const { doc, why } = await door(doorArgs(request, a));
		results.push({
			...a,
			ok: doc?.ok ?? false,
			state: doc?.state ?? null,
			reason: doc?.reason ?? why,
		});
		const declared = a.op === 'declare' && (doc?.ok || doc?.state === 'not-guaranteed');
		if (declared && agent) {
			// AN AGENT'S SLICE IS EMPTY UNTIL ITS EXECUTABLE IS THERE: the deploy
			// made the units, and only an install starts the agent. Install the
			// tenant's kept artifact through the same door (lib/hosting-artifacts.mjs).
			const installed = await installAgent(a.node, request.app, artifact, door, results);
			if (installed.ok) {
				const changed = `declared, agent ${installed.sha256.slice(0, 12)} installed`;
				rows.converged.push({ ...row, changed });
				rows.changed.push({ node: a.node, facet, changed });
			} else {
				rows.changed.push({ node: a.node, facet, changed: 'declared, agent not installed' });
				(installed.hard ? rows.unconverged : rows.deferred).push({ ...row, why: installed.why });
			}
		} else if (doc?.ok) {
			const changed =
				a.op === 'end'
					? `ends ${doc.until ?? `in ${a.inMin} min`}`
					: a.op === 'shrink'
						? `shrinks to ${a.units} unit(s) ${doc.until ?? `in ${a.inMin} min`}`
						: a.op === 'keep'
							? `kept, the end at ${doc.was} taken back`
							: a.op === 'resize'
								? `resized to ${a.units} unit(s) (${doc.state})`
								: `${a.op}d (${doc.state})`;
			rows.converged.push({ ...row, changed });
			rows.changed.push({ node: a.node, facet, changed });
		} else if (declared) {
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

/**
 * Install `artifact` on `node` through the door. `{ ok, sha256 }`, or
 * `{ ok: false, why, hard }`. With nothing kept yet the slice waits for the
 * tenant's first install, which the converger's clock pages on if it never
 * comes. A kept artifact that no longer verifies, or a door that refuses, is
 * hard: it pages now.
 */
async function installAgent(node, app, artifact, door, results) {
	if (!artifact)
		return {
			ok: false,
			hard: false,
			why:
				'no agent artifact kept for this tenant yet: one `fleet hosting <node> --install <run> ' +
				'--sha256 <hex>` keeps it, and every slice the fleet declares after that gets it',
		};
	if (!artifact.ok)
		return { ok: false, hard: true, why: `the kept agent artifact: ${artifact.why}` };
	const { doc, why } = await door([
		node,
		'--tenant',
		app,
		'--install',
		artifact.path,
		'--sha256',
		artifact.sha256,
	]);
	results.push({
		op: 'install',
		node,
		ok: doc?.ok ?? false,
		state: doc?.state ?? null,
		reason: doc?.reason ?? why,
	});
	return doc?.ok
		? { ok: true, sha256: artifact.sha256 }
		: { ok: false, hard: true, why: `installing the agent: ${doc?.reason ?? why ?? 'no answer'}` };
}
