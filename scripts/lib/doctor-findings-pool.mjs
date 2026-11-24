/**
 * doctor-findings-pool — the storage pool's health, judged from a typed input
 * (hadoku-fleet-manager#138, storage bootcamp F3). Shape: the `.d.mts` beside
 * this file.
 *
 * The pool is a 3-copy Garage cluster, one zone per node
 * (`replication_factor = 3`). Three questions:
 *
 *   - COPIES: does the cluster run at 3, and is every block on 3?
 *   - FILL: is any member's share of the pool nearly full?
 *   - N+1: could the pool lose any one member and still hold 3 copies of
 *     everything? That needs a spare zone (factor + 1 of them) AND the room:
 *     everything stored must fit on what is left after the biggest member goes.
 *
 * THE STATE IS READ by garage-admin.mjs's `readPool` (#141) through the first
 * member whose admin API answers; `garage` is null, with why, when none does.
 * A fleet where no node offers `storage` has no pool, and that is
 * `state: 'none'` with no finding. Members with no state read is a finding:
 * "I could not look".
 *
 * SHIPPED QUIET: every finding is ADVISORY with `shadow: true` until its
 * false-positive rate is known. One fleet-wide pool, so the findings' `node`
 * is `pool` unless one member is named.
 */

import { ADVISORY } from './preflight.mjs';

export const POOL_COPIES = 3;
/** A member's share of the pool at which it is worth a look. */
export const POOL_FILL_ADVISORY_PCT = 80;
/** A member's share at which Garage is close to refusing writes to it. */
export const POOL_FILL_FULL_PCT = 90;
/** A root-disk zone's `/` past this is over the line its quota was sized under (#141). */
export const ROOT_FS_CEILING_PCT = 80;

/**
 * PURE. Mark the root-disk zones: `rootFs[node]` is that node's `/` (the
 * doctor's own disk facet), null when it was not read. Other nodes unchanged.
 */
export function withRootZones(state, rootFs) {
	if (!state) return state;
	return {
		...state,
		nodes: state.nodes.map((n) => (n.node in rootFs ? { ...n, rootFs: rootFs[n.node] } : n)),
	};
}

const q = (node, category, status, why, extra = {}) => ({
	node,
	category,
	class: ADVISORY,
	status,
	why,
	shadow: true,
	...extra,
});

/** @param {import('./doctor-findings-pool.d.mts').PoolInput} input */
export function poolSummary(input) {
	const members = [...(input?.members ?? [])].sort();
	if (!members.length) {
		return { state: 'none', members, why: 'no node offers storage, so there is no Garage pool' };
	}
	if (!input.garage) {
		return { state: 'unread', members, why: input.why ?? 'nothing read the Garage cluster' };
	}
	return { state: 'read', members, why: null };
}

/** @param {import('./doctor-findings-pool.d.mts').PoolInput} input */
export function poolFindings(input) {
	const sum = poolSummary(input);
	if (sum.state === 'none') return [];
	if (sum.state === 'unread') {
		return [
			q(
				'pool',
				'pool-copies',
				'unread',
				`${sum.members.length} node(s) offer storage (${sum.members.join(', ')}) but the pool's ` +
					`state was not read: ${sum.why}. Copies, fill and N+1 are unknown, not fine.`
			),
		];
	}
	const g = input.garage;
	return [...copies(g), ...membership(sum.members, g), ...fill(g), ...nPlusOne(g)];
}

function copies(g) {
	const out = [];
	if (g.replicationFactor === null) {
		out.push(q('pool', 'pool-copies', 'unreadable', 'the cluster reported no replication factor.'));
	} else if (g.replicationFactor < POOL_COPIES) {
		out.push(
			q(
				'pool',
				'pool-copies',
				'factor-below-3',
				`the cluster runs replication_factor ${g.replicationFactor}, under ${POOL_COPIES}: ` +
					'one dead disk can be the last copy of a block.',
				{ replicationFactor: g.replicationFactor }
			)
		);
	}
	if (g.underReplicatedBlocks === null) {
		out.push(
			q(
				'pool',
				'pool-copies',
				'unreadable',
				'the count of blocks under their copy target was not read.'
			)
		);
	} else if (g.underReplicatedBlocks > 0) {
		out.push(
			q(
				'pool',
				'pool-copies',
				'under-replicated',
				`${g.underReplicatedBlocks.toLocaleString('en-US')} block(s) are on fewer than ` +
					`${g.replicationFactor ?? POOL_COPIES} copies. Garage resyncs them; a count that does ` +
					'not fall is a member that is not taking writes.',
				{ underReplicatedBlocks: g.underReplicatedBlocks }
			)
		);
	}
	return out;
}

function membership(members, g) {
	const out = [];
	const inLayout = new Set(g.nodes.map((n) => n.node));
	for (const m of members) {
		if (!inLayout.has(m)) {
			out.push(
				q(m, 'pool-node', 'not-in-layout', `${m} offers storage but is not in the Garage layout.`)
			);
		}
	}
	for (const n of g.nodes) {
		if (!n.up) {
			out.push(
				q(
					n.node,
					'pool-node',
					'down',
					`${n.node} is in the layout and down: every block it holds is one copy short.`
				)
			);
		}
	}
	return out;
}

function fill(g) {
	const out = [];
	for (const n of g.nodes) {
		if (n.rootFs !== undefined) out.push(...rootFill(n));
		if (n.capacityBytes === null || n.usedBytes === null || n.capacityBytes <= 0) {
			out.push(
				q(n.node, 'pool-fill', 'unreadable', `${n.node}'s pool capacity or use was not read.`)
			);
			continue;
		}
		const pct = Math.round((n.usedBytes / n.capacityBytes) * 1000) / 10;
		if (pct >= POOL_FILL_ADVISORY_PCT) {
			out.push(
				q(
					n.node,
					'pool-fill',
					pct >= POOL_FILL_FULL_PCT ? 'full' : 'tight',
					`${n.node}'s ${n.rootFs !== undefined ? 'root-disk quota' : 'share of the pool'} is ${pct}% used (over ${pct >= POOL_FILL_FULL_PCT ? POOL_FILL_FULL_PCT : POOL_FILL_ADVISORY_PCT}%).`,
					{ usedPct: pct }
				)
			);
		}
	}
	return out;
}

/** A root-disk zone's `/` against the 80% line its quota was sized under. */
function rootFill(n) {
	const fs = n.rootFs;
	if (!fs || !(fs.sizeBytes > 0)) {
		return [
			q(n.node, 'pool-fill', 'unreadable', `${n.node} is a root-disk zone and its / was not read.`),
		];
	}
	const pct = Math.round(((fs.sizeBytes - fs.availBytes) / fs.sizeBytes) * 1000) / 10;
	if (pct < ROOT_FS_CEILING_PCT) return [];
	return [
		q(
			n.node,
			'pool-fill',
			'root-over-ceiling',
			`${n.node}'s / is ${pct}% used, over the ${ROOT_FS_CEILING_PCT}% line its pool quota was sized ` +
				'under: the rest of the system has grown into the room the quota assumed.',
			{ rootUsedPct: pct }
		),
	];
}

function nPlusOne(g) {
	const rf = g.replicationFactor ?? POOL_COPIES;
	const zones = new Set(g.nodes.map((n) => n.zone ?? n.node));
	const out = [];
	if (zones.size < rf + 1) {
		out.push(
			q(
				'pool',
				'pool-n-plus-1',
				'no-spare-zone',
				`${zones.size} zone(s) for ${rf} copies: losing one member leaves nowhere to rebuild its ` +
					`third copy. N+1 needs ${rf + 1}.`,
				{ zones: zones.size, replicationFactor: rf }
			)
		);
	}
	if (g.nodes.some((n) => n.capacityBytes === null || n.usedBytes === null)) {
		out.push(
			q(
				'pool',
				'pool-n-plus-1',
				'unreadable',
				'a member has no capacity or use reading, so N+1 was not summed.'
			)
		);
		return out;
	}
	const used = g.nodes.reduce((a, n) => a + n.usedBytes, 0);
	const cap = g.nodes.reduce((a, n) => a + n.capacityBytes, 0);
	const biggest = g.nodes.reduce((a, n) => Math.max(a, n.capacityBytes), 0);
	if (used > cap - biggest) {
		out.push(
			q(
				'pool',
				'pool-n-plus-1',
				'no-headroom',
				`${used} bytes stored (every copy) against ${cap - biggest} left once the biggest member ` +
					'is gone: losing it would leave blocks with no room for their third copy.',
				{ usedBytes: used, survivingBytes: cap - biggest }
			)
		);
	}
	return out;
}
