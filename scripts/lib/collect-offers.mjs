/**
 * Gather every claw's hosting offer: one ssh each (as admin), the drain and
 * hosting records, the app layer's pm2 host list. Shared by
 * `fleet hosting-offers` and `fleet hosting-plan`, so both read the same
 * facts the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	nodeOffer,
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
} from '../../dist/capabilities.js';
import { readRevocations, revokedSets } from '../../dist/capability-revocations.js';
import { proofFileStatus, readProofsForCapability } from '../../dist/lib/measured.js';
import { readHostingDoc } from '../../dist/runners/hosting-record.js';
import { deferralFor, readDrainDoc, readDrains } from './expected-down.mjs';
import { runOn, selectNodes } from './fleet-exec.mjs';
import { OFFER_PROBE, offerFor, parseOfferProbe } from './hosting-offers.mjs';
import { siteRoot, stateDir } from './paths.mjs';

/** The app layer's pm2 hosts as `{ set }`, or `{ set: null, why }`: could not look is not "none". */
export function pm2Peers() {
	let p;
	try {
		p = join(siteRoot(), 'scripts', 'pm2-hosts.json');
		const doc = JSON.parse(readFileSync(p, 'utf8'));
		return { set: new Set(Object.keys(doc.hosts ?? doc)) };
	} catch (err) {
		return { set: null, why: `${p ?? 'the site checkout'}: ${err.message}` };
	}
}

/** Every hosting declaration per node, whole-box (a drain) and shared (its own file). */
export function tenantsByNode(drainDoc, hostingDoc) {
	const out = new Map();
	const add = (node, t) => out.set(node, [...(out.get(node) ?? []), t]);
	for (const [node, rec] of Object.entries(drainDoc.nodes))
		if (rec.kind === 'hosting' && rec.hosting) add(node, { ...pick(rec.hosting), mode: 'whole' });
	for (const [node, rec] of Object.entries(hostingDoc.nodes))
		add(node, { ...pick(rec), mode: 'shared' });
	return out;
}
const pick = ({ tenant, memoryMb, cores }) => ({ tenant, memoryMb, cores });

/**
 * The routing labels each node offers now, by the mint's own rule: `nodeOffer`
 * with the workload gate and the revocations, so a label a probe saw fail is
 * not offered to a tenant either. A corrupt `$proof` withholds every gated
 * label, as it does at the mint.
 */
export function offeredLabels(machines) {
	const dir = stateDir();
	const status = proofFileStatus({ dir });
	const proofs = Object.fromEntries(
		workloadGatedCapabilities().map((id) => [
			id,
			status.corrupt ? [] : readProofsForCapability(id, { dir }),
		])
	);
	const gate = workloadGateContext(Object.keys(machines), proofs, {
		corrupt: status.corrupt,
		revoked: revokedSets(readRevocations(dir)),
	});
	return (node) =>
		nodeOffer(machines[node] ?? {}, {
			eligible: false,
			workloadProofs: gate.byNode[node] ?? {},
			provenCounts: gate.provenCounts,
			revoked: revokedFor(gate, node),
		});
}

/** `{ offers, skippedByRole }` for every claw the manifest selects. */
export async function collectOffers(manifest) {
	const { nodes, skippedByRole } = selectNodes(manifest);
	const drainDoc = readDrainDoc();
	const hostingDoc = readHostingDoc(stateDir());
	const tenants = tenantsByNode(drainDoc, hostingDoc);
	const peers = pm2Peers();
	const drains = readDrains();
	const labelsOf = offeredLabels(manifest.machines ?? {});

	const offers = await Promise.all(
		nodes.map(async ([node, machine]) => {
			const r = await runOn(node, OFFER_PROBE, {
				as: 'admin',
				timeoutMs: 30_000,
				connectTimeout: 8,
			});
			const offer = offerFor({
				node,
				machine,
				facts: parseOfferProbe(r.stdout),
				tenants: tenants.get(node) ?? [],
				pm2Peer: peers.set === null ? null : peers.set.has(node),
				drain: drainDoc.nodes[node] ?? null,
				labels: labelsOf(node),
			});
			if (!offer.reachable) {
				offer.unknown.push(r.error ?? 'no answer');
				// A drained node may be down on purpose; it offers nothing, and that is not a failure.
				offer.expectedDown = deferralFor(node, drains).deferred;
			} else if (peers.set === null) offer.unknown.push(peers.why);
			return offer;
		})
	);

	return { offers, skippedByRole };
}
