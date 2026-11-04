/**
 * DOES ANY SERVICE DEPEND ON ONE CLAW? Asked hourly by `fleet hosting-verify`.
 *
 * On 2026-11-03 claw-4 dropped off the network for 1h40m with pygmalion and
 * archivebot on it, and neither could move: no service had a standby.
 * Operator: "we cannot be dependent on a single claw." This names every
 * service tenant that is, and fails the one that asked for redundancy and
 * does not have it.
 *
 *   - a service that declares no standby is an ADVISORY: it runs on one claw
 *     by its own request. Logged and listed, not paged, because it is a
 *     decision (and on day one it was every service). The advisory says
 *     whether it COULD have one: a standby needs the data-lease fence.
 *   - a service that declares `availability.standby: N` and has fewer than N
 *     standbys GUARANTEED on nodes other than its primary is a FINDING. The
 *     redundancy it asked for is not there, and that pages.
 *
 * Roles come from the hosting ledger (`role: "standby"` on the record), state
 * from `fleet hosting --check` read on the node. A standby that the check did
 * not read as guaranteed does not count: a declared copy is not a running one.
 *
 * PURE.
 */

/**
 * @param {Record<string, {request: object}>} tenants  the tenant registry's `tenants`
 * @param {{nodes?: Record<string, Array<{tenant: string, role?: string, until?: string|null}>>}} hostingDoc
 * @param {Array<{node: string, declared?: {tenant?: string}, state: string}>} rows  `hosting --check` rows
 * @param {number} nowMs
 * @returns {{advisories: object[], findings: object[]}}
 */
export function judgeRedundancy(tenants, hostingDoc, rows, nowMs) {
	const guaranteed = new Set(
		rows.filter((r) => r.state === 'guaranteed').map((r) => `${r.node}\0${r.declared?.tenant}`)
	);
	const inForce = (rec) => !rec.until || Date.parse(rec.until) > nowMs;
	const slicesOf = (app) =>
		Object.entries(hostingDoc.nodes ?? {}).flatMap(([node, recs]) =>
			(recs ?? [])
				.filter((r) => r.tenant === app && inForce(r))
				.map((r) => ({ node, role: r.role === 'standby' ? 'standby' : 'primary' }))
		);

	const advisories = [];
	const findings = [];
	for (const [app, entry] of Object.entries(tenants)) {
		const request = entry.request ?? {};
		if (request.kind !== 'service') continue;
		const slices = slicesOf(app);
		const primaries = slices.filter((s) => s.role === 'primary').map((s) => s.node);
		if (!primaries.length) continue;
		const wanted = request.availability?.standby ?? 0;
		const fenced = request.availability?.fence === 'data-lease';
		const facet = `hosting:${app}`;
		const where = primaries.join(', ');
		if (wanted === 0) {
			advisories.push({
				node: where,
				tenant: app,
				facet,
				category: 'single-claw',
				why:
					`${app} runs only on ${where} and declares no standby` +
					(fenced
						? ': it holds the data-lease fence, so `availability.standby: 1` is all it takes'
						: ': a standby needs the data-lease fence first (docs/service-state.md)'),
			});
			continue;
		}
		const standbys = slices
			.filter((s) => s.role === 'standby' && !primaries.includes(s.node))
			.filter((s) => guaranteed.has(`${s.node}\0${app}`))
			.map((s) => s.node);
		if (standbys.length < wanted) {
			findings.push({
				node: where,
				tenant: app,
				facet,
				category: 'standby-missing',
				why:
					`${app} asks for ${wanted} standby(s) and has ${standbys.length} guaranteed on another ` +
					`node (${standbys.join(', ') || 'none'}): a failure of ${where} takes it down`,
			});
		}
	}
	return { advisories, findings };
}
