#!/usr/bin/env node
/**
 * fleet hosting-offers — what each claw can lend to hosting, measured.
 *
 *   fleet hosting-offers            # every claw
 *   fleet hosting-offers --json
 *
 * The arithmetic and every rule are `lib/hosting-offers.mjs`. Read-only: one
 * ssh per claw (as admin), the drain and hosting records, and the app layer's
 * pm2 host list. It ranks nothing and recommends nothing; `fleet hosting-plan`
 * does that against a request. EXIT 0 only when every claw answered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { readHostingDoc } from '../dist/runners/hosting-record.js';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrainDoc, readDrains } from './lib/expected-down.mjs';
import { loadManifest, runOn, selectNodes } from './lib/fleet-exec.mjs';
import { OFFER_PROBE, offerFor, parseOfferProbe } from './lib/hosting-offers.mjs';
import { siteRoot, stateDir } from './lib/paths.mjs';

const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

/** The app layer's pm2 hosts as `{ set }`, or `{ set: null, why }`: could not look is not "none". */
function pm2Peers() {
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
function tenantsByNode(drainDoc, hostingDoc) {
	const out = new Map();
	const add = (node, t) => out.set(node, [...(out.get(node) ?? []), t]);
	for (const [node, rec] of Object.entries(drainDoc.nodes))
		if (rec.kind === 'hosting' && rec.hosting) add(node, { ...pick(rec.hosting), mode: 'whole' });
	for (const [node, rec] of Object.entries(hostingDoc.nodes))
		add(node, { ...pick(rec), mode: 'shared' });
	return out;
}
const pick = ({ tenant, memoryMb, cores }) => ({ tenant, memoryMb, cores });

async function main() {
	const manifest = loadManifest();
	const { nodes, skippedByRole } = selectNodes(manifest);
	const drainDoc = readDrainDoc();
	const hostingDoc = readHostingDoc(stateDir());
	const tenants = tenantsByNode(drainDoc, hostingDoc);
	const peers = pm2Peers();
	const drains = readDrains();

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
			});
			if (!offer.reachable) {
				offer.unknown.push(r.error ?? 'no answer');
				// A drained node may be down on purpose; it offers nothing, and that is not a failure.
				offer.expectedDown = deferralFor(node, drains).deferred;
			} else if (peers.set === null) offer.unknown.push(peers.why);
			return offer;
		})
	);

	for (const s of skippedByRole) log(`── ${s.node}  [skipped: ${s.role}]`);
	log('node     link   hostable MiB  cores  disk GB  CI job  CI   pm2           tenants');
	for (const o of offers) {
		if (!o.reachable) {
			log(
				`${o.node.padEnd(8)} ${o.expectedDown ? 'expected down' : 'UNREACHABLE'}: ${o.unknown.join('; ')}`
			);
			continue;
		}
		const pm2 = o.pm2.present ? (o.pm2.unbounded.length ? 'UNBOUNDED' : 'bounded') : '-';
		log(
			[
				o.node.padEnd(8),
				String(o.link ?? '?').padEnd(6),
				String(o.hostable.memoryMb ?? '?').padStart(12),
				String(o.hostable.cores ?? '?').padStart(6),
				String(o.hostable.diskFreeGb ?? '?').padStart(8),
				String(o.ci.jobMb ?? '?').padStart(7),
				(o.ci.cutOver ? 'own ' : 'root').padEnd(4),
				`${pm2}${o.pm2Peer ? ' (peer)' : ''}`.padEnd(13),
				o.tenants.map((t) => `${t.tenant} ${t.memoryMb}M/${t.cores}c ${t.mode}`).join(', ') || '-',
				o.drain ? `[drained: ${o.drain.kind}]` : '',
			].join(' ')
		);
		for (const u of o.unknown) log(`         ? ${u}`);
	}
	log(
		`hostable = MemTotal − minFreeMb − ${offers[0]?.ci?.keepJobs ?? 1} CI job − declared tenants − unbounded neighbours. CI "root": not cut over to its own user (node-users).`
	);
	const ok = offers.every((o) => o.reachable || o.expectedDown);
	if (emitter.json) emitter.emit({ ok, offers, skippedByRole });
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`hosting-offers: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
