/**
 * HOSTING DEMAND: how many slices each tenant wants now, said by the tenant
 * (fleet-manager#16, agreed with cardtable 2026-10-28).
 *
 * A COUNT, not "add one / release one". The tenant restates N on every poll.
 * The same N writes nothing new but the time it was last asked, so a restart,
 * a lost call or a duplicate cannot drift it. The converger meets N within the
 * request's `slices.min..max`.
 *
 * `releaseOrder` is the tenant's: slices hold live work only it can see. When N
 * drops, the converger ends slices from the head of that list and never picks
 * one itself. Every end it makes goes through `--end --in <noticeMin>`.
 *
 * `~/.hadoku-mgmt/hosting-demand.json`. Unreadable THROWS: a converger that
 * read "no demand" would shrink every tenant to its minimum.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILE = 'hosting-demand.json';

export function readDemand(dir) {
	const p = join(dir, FILE);
	if (!existsSync(p)) return { tenants: {} };
	const doc = JSON.parse(readFileSync(p, 'utf8'));
	if (!doc || typeof doc.tenants !== 'object') throw new Error(`${p} has no tenants map`);
	return doc;
}

/**
 * The tenant's own slices, split as the view reports them: `declared` (serving,
 * no end set) and `ending`. Another tenant's slice is never listed, and neither
 * is a hot standby (`role: "standby"`): a tenant reads `declared` as the slices
 * serving it, and the converger counts it against the demand.
 * `hostingOn(node)` is hosting-record's answer for one node.
 */
export function tenantSlices(app, nodes, hostingOn) {
	const declared = [];
	const ending = [];
	for (const node of nodes) {
		const h = hostingOn(node);
		if (h?.tenant !== app || h.role === 'standby') continue;
		if (h.until) ending.push({ node, until: h.until });
		else declared.push({ node, mode: h.mode, memoryMb: h.memoryMb, cores: h.cores });
	}
	return { declared, ending };
}

/** Problems with asking `request` for `slices`, or [] when the ask is valid. */
export function demandProblems(request, slices, releaseOrder) {
	const out = [];
	const { min, max } = request.slices;
	if (!(Number.isInteger(slices) && slices >= min && slices <= max))
		out.push(`--slices must be a whole number from ${min} to ${max} for ${request.app}`);
	if (new Set(releaseOrder).size !== releaseOrder.length)
		out.push('--release-order names a node twice');
	return out;
}

/**
 * Record the ask. Returns `{ changed }`: false when N and the order are what
 * was already asked, which is the steady state of a tenant polling.
 */
export function writeDemand(dir, app, { slices, releaseOrder, by }, nowIso) {
	const doc = readDemand(dir);
	const prev = doc.tenants[app];
	const changed =
		!prev ||
		prev.slices !== slices ||
		JSON.stringify(prev.releaseOrder ?? []) !== JSON.stringify(releaseOrder);
	doc.tenants[app] = {
		slices,
		releaseOrder,
		since: changed ? nowIso : prev.since,
		askedAt: nowIso,
		by,
	};
	const p = join(dir, FILE);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(`${p}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
	renameSync(`${p}.tmp`, p);
	return { changed };
}
