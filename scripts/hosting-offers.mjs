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
import process from 'node:process';

import { collectOffers } from './lib/collect-offers.mjs';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';

const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

async function main() {
	const { offers, skippedByRole } = await collectOffers(loadManifest());

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
