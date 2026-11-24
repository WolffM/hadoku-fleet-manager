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
 * or a fill or a block count that was not reported: each goes to `unreadable`,
 * and the job is red. No pool at all (no node offers `storage`) is the one
 * green answer with nothing read: `state: 'none'`.
 *
 * THE 24 HOURS NEED A MEMORY. Garage reports how many blocks are short now,
 * not since when, so the gate keeps `underReplicatedSince`: the first run that
 * saw a count above zero. Any run that reads zero clears it; a run that could
 * not read the count keeps it, because not looking is not "resynced".
 *
 * A DRAINED POOL IS EXPECTED DOWN (expected-down.mjs). The cluster is read
 * through any member, so one drained node changes nothing. When no member
 * answered and EVERY member is deferred (a dated human drain, inside its
 * window), the unread pool is a warning carrying each deferral note. Anything
 * short of every member stays "could not look" and fails.
 */

import { POOL_COPIES, poolFindings, poolSummary } from './doctor-findings-pool.mjs';

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
		if (f.status === 'unread' && summary.members.every((m) => deferred.has(m))) {
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

	const ok = page.length === 0 && unreadable.length === 0;
	return {
		ok,
		state: summary.state,
		members: summary.members,
		findings: page,
		warnings: warn,
		known,
		unreadable,
		record: { underReplicatedSince: since, at: now.toISOString() },
		...(ok ? {} : { why: whyLine(page, unreadable) }),
		summary: summaryLine(summary, page, warn, known, unreadable),
	};
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
