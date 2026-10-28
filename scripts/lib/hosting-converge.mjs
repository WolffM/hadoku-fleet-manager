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
 *
 * STANDBYS (`availability.standby`, docs/service-state.md) are counted apart:
 * a slice with `role: "standby"` is never serving, never in `held`, and never
 * a second writer. They are met from the plan's own `standby` entry (every
 * primary rule, runtime included, never the primary's node) and only beside a
 * primary held in this layer: a standby of nothing is a second instance. One
 * past the count is ended with the tenant's notice; it holds no authority, so
 * no release order is needed. An unplaceable standby is replaced, not ended.
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
 * @param {{node: string|null}|{unreadable: string}} [i.appLayer] for a service:
 *        where hadoku_site runs it now (appLayerHost), or why that could not be read
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
	notices,
	now,
	appLayer = null,
}) {
	const { app, slices: size, availability, placement } = request;
	const slices = allSlices.filter((s) => s.role !== 'standby');
	const standbySlices = allSlices.filter((s) => s.role === 'standby');
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

	// A SERVICE THE APP LAYER ALREADY RUNS is adopted by a move, never declared
	// beside itself: no slice is not "not running". Could not look is the same block.
	const runningAt =
		request.kind === 'service' && slices.length === 0 && appLayer
			? (appLayer.unreadable ?? null)
			: null;
	const adoptFrom =
		request.kind === 'service' && slices.length === 0 && appLayer?.node ? appLayer.node : null;

	if (serving.length < desired && (adoptFrom || runningAt)) {
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
	} else if (serving.length < desired) {
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

	const standby = meetStandby({
		request,
		plan,
		standbySlices,
		primaryHeld: slices.filter((s) => !s.until).length,
		fault: (node) => faultOf(node, offerOf.get(node), placement.require, notices, now, horizonMs),
		offerOf,
		actions,
		blocked,
	});
	return {
		app,
		desired,
		serving,
		ending,
		unplaceable,
		actions,
		blocked,
		...(standby ? { standby } : {}),
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
			...(a.role ? ['--role', a.role] : []),
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
			const installed = await installAgent(a.node, artifact, door, results);
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
				a.op === 'end' ? `ends ${doc.until ?? `in ${a.inMin} min`}` : `${a.op}d (${doc.state})`;
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
async function installAgent(node, artifact, door, results) {
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
	const { doc, why } = await door([node, '--install', artifact.path, '--sha256', artifact.sha256]);
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
