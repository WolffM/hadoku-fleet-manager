/**
 * EVERY TENANT DECLARED PER NODE — a pure merge of the two hosting records
 * (the drain doc's whole-box holds, `fleet-hosting.json`'s shared slices)
 * into one map, node → declarations.
 *
 * MOVED OUT of `collect-offers.mjs` (wave layers-3 lane H, cut (iii) layer
 * debt): zero-import and pure over records both already read elsewhere, so
 * it belongs at state, below both of its callers' domains, rather than at
 * tenancy where `collect-offers.mjs` sits. `doctor-run.mjs` (observation)
 * and `slice-inventory-run.mjs` (tenancy) each needed it without reaching
 * UP into collect-offers' tenancy table to get it. `collect-offers.mjs`
 * re-exports it unchanged, so every existing importer keeps compiling and
 * behaving byte-identically.
 */

const pick = ({ tenant, memoryMb, cores, role }) => ({
	tenant,
	memoryMb,
	cores,
	...(role ? { role } : {}),
});

/** Every hosting declaration per node, whole-box (a drain) and shared (its own file). */
export function tenantsByNode(drainDoc, hostingDoc) {
	const out = new Map();
	const add = (node, t) => out.set(node, [...(out.get(node) ?? []), t]);
	for (const [node, rec] of Object.entries(drainDoc.nodes))
		if (rec.kind === 'hosting' && rec.hosting) add(node, { ...pick(rec.hosting), mode: 'whole' });
	for (const [node, recs] of Object.entries(hostingDoc.nodes))
		for (const rec of recs) add(node, { ...pick(rec), mode: 'shared' });
	return out;
}
