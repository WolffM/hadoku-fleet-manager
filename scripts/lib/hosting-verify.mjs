/**
 * HOSTING VERIFY: which hosted tenants' homes the fleet should put back, from
 * one `fleet hosting --check --json` (fleet-manager#31).
 *
 * `--check` reads every declared slice from the node: the units, the cgroup
 * limits, the home files (the tokenless `.npmrc` among them), CI's headroom
 * and ranking, the port. Until 2026-10-31 nothing ran it on a schedule, so a
 * tenant's `.npmrc` going missing surfaced as the tenant's next deploy failing
 * with a 401 (#28).
 *
 * THE REPAIR IS `--reassert`: the node side of the slice again, from its
 * record, the record untouched. It is idempotent and restarts the tenant only
 * when a unit's text changed, so it is safe to run on anything not
 * guaranteed. What it cannot fix it does not try:
 *   - a node that did not answer is UNREADABLE: "could not look" is never
 *     "fine", and never a reason to write to the node either;
 *   - a tenant that is not registered has no spec to re-deploy from;
 *   - a slice past its end belongs to `--remove` (the hosting converger's).
 */

/** Categories the node side cannot repair: there is nothing to re-deploy, or no node to deploy to. */
const NOT_REPAIRABLE = new Set(['hosting-unobserved', 'hosting-tenant']);

const blockingWhy = (row) =>
	(row.findings ?? [])
		.filter((f) => f.class === 'blocking')
		.map((f) => `${f.category}: ${f.why}`)
		.join('; ');

/**
 * Sort `--check`'s rows. `facet` is `hosting:<tenant>`, the hosting
 * converger's own facet name, so a page names the tenant the same way.
 *
 * @param {Array<{node: string, declared?: {tenant?: string}, until?: string|null, state: string, findings?: Array<{class: string, category: string, why: string}>}>} rows
 * @param {number} nowMs
 */
export function planVerify(rows, nowMs) {
	const repair = [];
	const unreadable = [];
	const unrepairable = [];
	const lapsed = [];
	for (const row of rows) {
		if (row.state === 'guaranteed') continue;
		const tenant = row.declared?.tenant ?? '?';
		const item = { node: row.node, tenant, facet: `hosting:${tenant}`, before: blockingWhy(row) };
		const categories = new Set(
			(row.findings ?? []).filter((f) => f.class === 'blocking').map((f) => f.category)
		);
		const endMs = Date.parse(row.until ?? '');
		if (categories.has('hosting-unobserved')) unreadable.push(item);
		else if (Number.isFinite(endMs) && endMs <= nowMs) lapsed.push(item);
		else if ([...categories].some((c) => NOT_REPAIRABLE.has(c))) unrepairable.push(item);
		else repair.push(item);
	}
	return { repair, unreadable, unrepairable, lapsed };
}
