/**
 * storage-pool-gate — the `ci:storage-pool` verdict over the pool's findings
 * (hadoku-fleet-manager#142, storage bootcamp F7).
 *
 * The numbers and the questions are F3's (`doctor-findings-pool.mjs`): this
 * file never re-derives a threshold, it sorts F3's findings into three bins.
 *
 *   PAGE (fails the job)   a block on fewer than 3 copies for more than
 *                          24 h; a disk over POOL_FILL_FULL_PCT; a factor
 *                          under 3; fewer zones than copies.
 *   WARN (reported, ok)    N+1 broken; a disk over POOL_FILL_ADVISORY_PCT;
 *                          a member down or missing from the layout; a block
 *                          under its copies for less than 24 h.
 *   KNOWN (reported, ok)   N+1 with exactly as many zones as copies. The
 *                          pilot runs 3 zones for 3 copies, where N+1 cannot
 *                          hold by construction: it is the pool's state, not
 *                          a failure, until a fourth zone joins.
 *
 * "I COULD NOT LOOK" FAILS. Members whose cluster nobody could read, a factor
 * or a fill or a block count that was not reported, a garage-layout.json that
 * could not be read: each goes to `unreadable`, and the job is red. No pool
 * at all (no zone declared; #153) is the one green answer with nothing read.
 *
 * THE 24 HOURS NEED A MEMORY. Garage reports how many blocks are short now,
 * not since when, so the gate keeps `underReplicatedSince`: the first run that
 * saw a count above zero. Any run that reads zero clears it; a run that could
 * not read the count keeps it, because not looking is not "resynced".
 *
 * EVERY MEMBER IS ASKED WHAT IT SEES (#154). The pool numbers come through
 * one member, but a split is only visible from the others: claw-1 saw 3/3
 * while claw-8 and claw-9 saw claw-1 as never seen. `input.views` is each
 * member's own GetClusterStatus (garage-admin.mjs `readMemberViews`). A member
 * seeing another as failed or never seen is a `pool-view/*` finding on the
 * node it cannot see, naming who cannot see it and who can. Same bands as
 * under-replication: warn under 24 h, page past it, the clock is
 * `splitSince`. A member whose view cannot be read is unreadable, unless it
 * is drained (then a warning with the note), or the other members see it
 * down: then it is down, and its view finding (with the clock) is the one
 * answer, never an unreadable that would fail the gate at minute one. A
 * target that is drained is known, not a split.
 *
 * EACH MEMBER'S DISKS ARE ASKED TOO. A block failing its checksum is restored
 * from a peer and the bad copy kept as `*.corrupted` (the 2026-11-24 drill);
 * a non-zero count per data dir, or resync errors in the member's statistics,
 * warns naming the node and disk. A count that could not be taken is
 * unreadable, like any other could-not-look.
 *
 * A DRAINED POOL IS EXPECTED DOWN (expected-down.mjs). The cluster is read
 * through any member, so one drained node changes nothing. When no member
 * answered and EVERY member is deferred (a dated human drain, inside its
 * window), the unread pool is a warning carrying each deferral note. Anything
 * short of every member stays "could not look" and fails.
 */

import { POOL_COPIES, poolFindings, poolSummary } from './doctor-findings-pool.mjs';
import { seenBy } from './garage-admin.mjs';

/** How long blocks may sit under their copy target before it pages. */
export const UNDER_REPLICATED_PAGE_MS = 24 * 3600_000;

const entry = (f) => ({ node: f.node, kind: `${f.category}/${f.status}`, reason: f.why });

/**
 * @param {import('./doctor-findings-pool.d.mts').PoolInput} input
 * @param {{ underReplicatedSince?: string | null } | null} prior the last run's record
 * @param {Date} now
 * @param {Map<string, string>} [deferred] member -> expected-down note, for the members deferred
 */
export function judgePool(input, prior, now, deferred = new Map()) {
	const summary = poolSummary(input);
	const page = [];
	const warn = [];
	const known = [];
	const unreadable = [];
	const g = input?.garage ?? null;
	const blocks = g?.underReplicatedBlocks ?? null;
	const priorSince = prior?.underReplicatedSince ?? null;
	const since =
		summary.state !== 'read' || blocks === null
			? priorSince
			: blocks > 0
				? (priorSince ?? now.toISOString())
				: null;
	const rf = g?.replicationFactor ?? POOL_COPIES;

	for (const f of poolFindings(input)) {
		const e = entry(f);
		const allDeferred = summary.members.length > 0 && summary.members.every((m) => deferred.has(m));
		if (f.status === 'unread' && !input?.membersWhy && allDeferred) {
			warn.push({
				...e,
				reason: `${e.reason} Every member is expected down: ${[...deferred.values()].join('; ')}.`,
			});
		} else if (f.status === 'unread' || f.status === 'unreadable') {
			unreadable.push({ node: f.node, why: f.why });
		} else if (f.category === 'pool-copies' && f.status === 'under-replicated') {
			const age = now.getTime() - Date.parse(since ?? now.toISOString());
			const hours = Math.floor(age / 3600_000);
			const withAge = { ...e, reason: `${e.reason} Short for ${hours} h (since ${since}).` };
			(age > UNDER_REPLICATED_PAGE_MS ? page : warn).push(withAge);
		} else if (
			f.category === 'pool-copies' ||
			(f.category === 'pool-fill' && f.status === 'full')
		) {
			page.push(e);
		} else if (f.category === 'pool-n-plus-1') {
			const zones = new Set((g?.nodes ?? []).map((n) => n.zone ?? n.node)).size;
			if (zones < rf)
				page.push({ ...e, reason: `${e.reason} Fewer zones than copies: every block is short.` });
			else if (zones === rf)
				known.push({ ...e, reason: `${e.reason} Known with ${zones} zones: N+1 needs ${rf + 1}.` });
			else warn.push(e);
		} else {
			warn.push(e);
		}
	}

	const split = summary.state === 'read' ? judgeViews(input, deferred) : null;
	// Started by any split seen, cleared only by a full read that saw none.
	const splitSince = split?.pairs.length
		? (prior?.splitSince ?? now.toISOString())
		: split?.complete
			? null
			: (prior?.splitSince ?? null);
	if (split) {
		const age = now.getTime() - Date.parse(splitSince ?? now.toISOString());
		const hours = Math.floor(age / 3600_000);
		for (const f of split.pairs) {
			const withAge = { ...f, reason: `${f.reason} Split for ${hours} h (since ${splitSince}).` };
			(age > UNDER_REPLICATED_PAGE_MS ? page : warn).push(withAge);
		}
		warn.push(...split.warn);
		known.push(...split.known);
		unreadable.push(...split.unreadable);
	}

	const ok = page.length === 0 && unreadable.length === 0;
	return {
		ok,
		state: summary.state,
		members: summary.members,
		findings: page,
		warnings: warn,
		known,
		unreadable,
		views: split?.views ?? [],
		record: { underReplicatedSince: since, splitSince, at: now.toISOString() },
		...(ok ? {} : { why: whyLine(page, unreadable) }),
		summary: summaryLine(summary, page, warn, known, unreadable),
	};
}

/**
 * PURE. Every member's view as findings. `complete` is false when a view
 * nobody accounts for was not read: the split clock is then kept, not cleared.
 */
export function judgeViews(input, deferred = new Map()) {
	const members = input?.members ?? [];
	const out = { views: [], pairs: [], warn: [], known: [], unreadable: [], complete: true };
	const viewOf = new Map((input?.views ?? []).map((v) => [v.node, v]));
	const read = members.filter((m) => viewOf.get(m)?.status);
	const unread = new Map(
		members
			.filter((m) => !viewOf.get(m)?.status)
			.map((m) => [m, viewOf.get(m)?.why || 'its view was not read'])
	);
	const blind = new Map();
	const upBy = new Map();
	for (const node of members) {
		if (unread.has(node)) {
			out.views.push({ node, read: false, why: unread.get(node) });
			continue;
		}
		const v = viewOf.get(node);
		const sees = seenBy(v.status);
		const h = v.health;
		out.views.push({
			node,
			read: true,
			health: h ? `${h.status}, ${h.storageNodesUp}/${h.storageNodes} up` : null,
			sees,
		});
		for (const target of members) {
			if (target === node) continue;
			const state = sees[target] ?? 'never-seen';
			const into = state === 'up' ? upBy : blind;
			into.set(target, [...(into.get(target) ?? []), { observer: node, state }]);
		}
	}
	for (const [target, seen] of blind) {
		const worst = seen.some((s) => s.state === 'never-seen') ? 'never-seen' : 'failed';
		const who = seen.map((s) => `${s.observer} (${s.state})`).join(', ');
		const ups = (upBy.get(target) ?? []).map((s) => s.observer);
		let reason =
			`${who} cannot see ${target}` +
			(ups.length ? `, while ${ups.join(', ')} see${ups.length === 1 ? 's' : ''} it up.` : '.');
		// A member others see down and whose own view is unread is DOWN: one
		// finding, under the split clock, never an unreadable that outranks it.
		if (unread.has(target)) reason += ` Its own view was not read: ${unread.get(target)}.`;
		else {
			const own = out.views.find((x) => x.node === target);
			const ownUp = Object.values(own?.sees ?? {}).filter((x) => x === 'up').length;
			reason += ` ${target} itself sees ${ownUp}/${members.length} up.`;
		}
		const f = { node: target, kind: `pool-view/${worst}`, reason };
		if (deferred.has(target))
			out.known.push({ ...f, reason: `${reason} ${deferred.get(target)}.` });
		else out.pairs.push(f);
	}
	for (const [node, why] of unread) {
		if (blind.has(node) && read.length) continue;
		out.complete = false;
		const reason = `${node}'s own view of the cluster was not read: ${why}`;
		if (deferred.has(node))
			out.warn.push({ node, kind: 'pool-view/unread', reason: `${reason} ${deferred.get(node)}.` });
		else out.unreadable.push({ node, why: reason });
	}
	// The disks' own word (#154 scope): quarantined copies and resync errors.
	const resyncBy = new Map((input?.garage?.nodes ?? []).map((n) => [n.node, n.resyncErrors]));
	for (const v of out.views) {
		const src = viewOf.get(v.node);
		v.resyncErrors = resyncBy.get(v.node) ?? null;
		if (v.resyncErrors > 0)
			out.warn.push({
				node: v.node,
				kind: 'pool-disk/resync-errors',
				reason: `${v.node} holds ${v.resyncErrors} block(s) with resync errors: copies it could not fetch or write.`,
			});
		if (!src || !('corruptedWhy' in src)) continue;
		v.corrupted = src.corrupted;
		if (src.corrupted === null) {
			v.corruptedWhy = src.corruptedWhy;
			const reason = `${v.node}'s quarantined (*.corrupted) blocks were not counted: ${src.corruptedWhy}`;
			if (!v.read && unread.has(v.node)) continue;
			if (deferred.has(v.node))
				out.warn.push({
					node: v.node,
					kind: 'pool-disk/unread',
					reason: `${reason} ${deferred.get(v.node)}.`,
				});
			else out.unreadable.push({ node: v.node, why: reason });
			continue;
		}
		for (const d of src.corrupted) {
			if (d.count > 0)
				out.warn.push({
					node: v.node,
					kind: 'pool-disk/corrupted',
					reason:
						`${v.node} disk ${d.disk} has ${d.count} quarantined block cop${d.count === 1 ? 'y' : 'ies'} ` +
						`(*.corrupted under ${d.path}): Garage restored each from a peer; a count that grows is a disk going bad.`,
				});
		}
	}
	return out;
}

function whyLine(page, unreadable) {
	const parts = [];
	if (page.length)
		parts.push(`${page.length} pool finding(s) that page: ${page.map((p) => p.kind).join(', ')}`);
	if (unreadable.length)
		parts.push(`${unreadable.length} unreadable: ${unreadable.map((u) => u.why).join(' | ')}`);
	return parts.join('; ');
}

function summaryLine(summary, page, warn, known, unreadable) {
	if (summary.state === 'none') return `no pool: ${summary.why}`;
	const counts = `${page.length} page, ${warn.length} warn, ${known.length} known, ${unreadable.length} unreadable`;
	return `pool ${summary.state} (${summary.members.join(', ')}): ${counts}`;
}
