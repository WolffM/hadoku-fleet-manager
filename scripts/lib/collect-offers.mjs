/**
 * Gather every claw's hosting offer: one ssh each (as admin), the drain and
 * hosting records, the app layer's pm2 host list. Shared by
 * `fleet hosting-offers` and `fleet hosting-plan`, so both read the same
 * facts the same way.
 */
import { join } from 'node:path';

import { nodeOffer } from '../../dist/lib/capability-offer.js';
import {
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
} from '../../dist/lib/workload-gate.js';
import { readRevocations, revokedSets } from '../../dist/capability-revocations.js';
import { proofFileStatus, readProofsForCapability } from '../../dist/lib/measured-proof.js';
import { readHostingDoc } from '../../dist/runners/hosting-record.js';
import { isBackstopNode } from '../../dist/lib/node-role.js';
import { deferralFor, readDrainDoc, readDrains } from './expected-down.mjs';
import { runOn, selectMachines } from './fleet-exec.mjs';
import { offerFor, offerProbe, parseOfferProbe } from './hosting-offers.mjs';
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { CAPACITY_SAMPLE_FILE, capacitySampleStore } from '../../dist/capacity-sample-store.js';
import { reliabilityOf } from './host-reliability.mjs';
import { pm2Peers } from './pm2-app-layer.mjs';
import { tenantsByNode } from './tenant-declarations.mjs';

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

/**
 * `{ offers, skippedByRole }` for every claw in the manifest. The backstop is
 * not lent to a hosting tenant: it is not capacity, and it is the production
 * host. It is listed in `skippedByRole` rather than dropped.
 * `tools`: the executables the tenants being planned ask for (`runtime.tools`), run on every node.
 */
export async function collectOffers(manifest, { tools = [] } = {}) {
	const nodes = selectMachines(manifest, { where: (m) => !isBackstopNode(m) });
	const skippedByRole = selectMachines(manifest, { where: isBackstopNode }).map(([node]) => ({
		node,
		role: 'backstop',
		why: 'the emergency backstop and the production host: not lent to a hosting tenant',
	}));
	const drainDoc = readDrainDoc();
	const hostingDoc = readHostingDoc(stateDir());
	const tenants = tenantsByNode(drainDoc, hostingDoc);
	const peers = pm2Peers();
	const drains = readDrains();
	const labelsOf = offeredLabels(manifest.machines ?? {});
	const reliability = reliabilityOf(readSamples(), Date.now());

	const offers = await Promise.all(
		nodes.map(async ([node, machine]) => {
			const r = await runOn(node, offerProbe(tools), {
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
			offer.reliability = reliability(node);
			return offer;
		})
	);

	return { offers, skippedByRole };
}

/** The capacity samples, or why they could not be read: "could not look" is carried, never empty. */
function readSamples() {
	try {
		return capacitySampleStore(join(stateDir(), CAPACITY_SAMPLE_FILE)).read();
	} catch (err) {
		return { error: err.message };
	}
}
