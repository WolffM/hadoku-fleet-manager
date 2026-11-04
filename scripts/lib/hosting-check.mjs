/**
 * ONE SLICE, CHECKED FROM ITS NODE: what `fleet hosting --check` reports per
 * slice, and what `fleet hosting-placement` reports for one app's slices.
 * Moved out of scripts/hosting.mjs (fleet-manager#16) so the two cannot judge
 * a slice two ways. The judgement itself is `judgeHosting` in lib/hosting.mjs;
 * this is the observe-and-probe around it.
 *
 * Nothing here reads the unit files the fleet wrote: the node's cgroups,
 * users, files and sockets, and a connection from the controller and a peer.
 */
import { nodeUser } from '../../dist/lib/node-users.js';
import {
	NO_TENANT,
	judgeHosting,
	observeScript,
	parseObserved,
	peerCandidates,
	probeReach,
} from './hosting.mjs';

/**
 * Every shared slice on `name` summed, lapsed ones included: a lapsed slice
 * keeps its units, and its protection, until `--remove`.
 */
export const slicesMb = (doc, name) => (doc.nodes[name] ?? []).reduce((s, r) => s + r.memoryMb, 0);

/** Every hosting record, either kind, lapsed or not — a lapsed one is still checked. One row per tenant. */
export function hostingRecords(drainDoc, hostingDoc) {
	const out = [];
	for (const [name, rec] of Object.entries(drainDoc.nodes)) {
		if (rec.kind === 'hosting' && rec.hosting)
			out.push({ name, mode: 'whole', declared: rec.hosting, until: rec.until ?? null });
	}
	for (const [name, recs] of Object.entries(hostingDoc.nodes)) {
		for (const rec of recs) {
			const { tenant, memoryMb, cores, port } = rec;
			out.push({
				name,
				mode: 'shared',
				declared: { tenant, memoryMb, cores, port },
				until: rec.until ?? null,
				...(rec.shrinkTo ? { shrinkTo: rec.shrinkTo } : {}),
			});
		}
	}
	return out;
}

/** The node's own answer to the observe script: `{ obs, error }`, `obs` null when it did not finish. */
export async function observeNode({ manifest, run }, name, spec) {
	const r = await run(
		name,
		observeScript(spec ?? NO_TENANT, nodeUser(manifest.machines?.[name], 'ci')),
		{ as: 'admin', timeoutMs: 30_000, connectTimeout: 6 }
	);
	return { obs: parseObserved(r.stdout), error: r.ok ? null : (r.error ?? r.stderr.trim()) };
}

/**
 * Declared against observed, judged: `{ row, answered }`. `row` is exactly
 * what `--check` prints per slice. `answered` is false when the node did not
 * finish answering, so a reader can say "could not look" rather than read
 * `not-guaranteed` as a verdict about the slice.
 *
 * `ctx`: `{ manifest, hostingDoc, specOf(tenant), run }`, `run` being
 * fleet-exec's `runOn`.
 */
export async function checkSlice(ctx, { name, mode, declared, until, shrinkTo }) {
	const { manifest, hostingDoc, specOf, run } = ctx;
	const spec = specOf(declared.tenant);
	const { obs, error } = await observeNode(ctx, name, spec);
	// Reach is a `controller` ingress's question; a loopback tenant is judged from its socket.
	const reach =
		obs && spec?.ingress === 'controller'
			? await probeReach({
					port: declared.port,
					addrs: {
						lan: manifest.machines?.[name]?.lan?.ip ?? null,
						tailnet4: obs.tailnet4,
						tailnet6: obs.tailnet6,
					},
					peers: peerCandidates(manifest, name),
					run,
				})
			: null;
	const nodeMb = mode === 'shared' ? slicesMb(hostingDoc, name) : declared.memoryMb;
	const judged = judgeHosting(declared, obs, mode, reach, spec, nodeMb);
	if (!obs && error) judged.findings[0].why += ` (${error})`;
	const blocking = judged.findings.some((f) => f.class === 'blocking');
	return {
		answered: Boolean(obs),
		row: {
			node: name,
			mode,
			declared,
			until,
			...(shrinkTo ? { shrinkTo } : {}),
			state: blocking ? 'not-guaranteed' : 'guaranteed',
			...judged,
		},
	};
}
