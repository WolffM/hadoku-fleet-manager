/**
 * `fleet service-inventory --slices` — every DECLARED hosting slice, measured
 * on the node that runs it, from the controller.
 *
 * The rest of service-inventory measures the box it runs on (hokon's pm2, cron,
 * checkouts, mirror). A hosting tenant runs in `hosting.slice/hosting-<app>.slice`
 * on a claw, where this package is not installed, so this half reads the
 * declarations here and asks each node over `runOn`: one ssh, two cgroup reads
 * a window apart (`sliceProbe`). The rows are `kind: slice` in the same demand
 * ledger, so a hosting request can be sized from what its slice actually held.
 *
 * Every declared slice that could not be read is a finding, with the reason,
 * and its last rows are KEPT: an unreachable node is not a slice that emptied.
 * A host that carries slice rows and no longer declares one has them removed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostingSliceCgroup, readHostingDoc } from '../../dist/runners/hosting-record.js';
import { tenantsByNode } from './collect-offers.mjs';
import { readDrainDoc } from './expected-down.mjs';
import { runOn } from './fleet-exec.mjs';
import { stateDir } from './paths.mjs';
import {
	RESIDENT_CLASS,
	mergeResidentRows,
	parseSliceProbe,
	sliceProbe,
	sliceRow,
	validateResidentRow,
} from './service-inventory.mjs';

const READ_ATTEMPTS = 2;
const BY = 'fleet service-inventory --slices';

/** Measure every declared slice. `{ ok, at, rows, findings, write }`. */
export async function runSliceInventory({ windowMs, write }) {
	const at = new Date().toISOString();
	const windowS = Math.max(1, Math.round(windowMs / 1000));
	const declared = tenantsByNode(readDrainDoc(), readHostingDoc(stateDir()));
	const findings = [];
	const rows = [];
	const measuredHosts = [];

	await Promise.all(
		[...declared].map(async ([node, tenants]) => {
			const slices = [...new Set(tenants.map((t) => t.tenant))].map((app) => ({
				app,
				cgroup: hostingSliceCgroup(app),
			}));
			let samples = null;
			let why = null;
			for (let attempt = 1; attempt <= READ_ATTEMPTS && !samples; attempt++) {
				// A guest is measured too: this only reads a slice its declaration put there.
				const r = await runOn(node, sliceProbe(slices, windowS), {
					includeGuests: true,
					as: 'admin',
					timeoutMs: (windowS + 30) * 1000,
					connectTimeout: 8,
				});
				samples = parseSliceProbe(r.stdout);
				if (!samples) why = r.error ?? 'the probe never printed SLICES-END';
			}
			if (!samples) {
				findings.push(
					`${node}: its declared slice(s) ${slices.map((s) => s.app).join(', ')} could not be ` +
						`read in ${READ_ATTEMPTS} attempts (${why}); their last rows are kept`
				);
				return;
			}
			for (const { app } of slices) {
				const s = samples.get(app);
				if (s?.b?.absent) {
					findings.push(`${node}: ${app} is declared here but its slice cgroup does not exist`);
				}
				rows.push(sliceRow({ app, host: node, samples: s, at, by: BY }));
			}
			measuredHosts.push(node);
		})
	);
	for (const r of rows) validateResidentRow(r);
	rows.sort((a, b) => `${a.host}/${a.name}`.localeCompare(`${b.host}/${b.name}`));

	let writeResult = null;
	if (write) {
		const path = join(stateDir(), 'demand-ledger.jsonl');
		let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
		// Hosts whose slice rows must go: they no longer declare any slice.
		const stale = new Set();
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			const p = JSON.parse(line);
			if (p.class === RESIDENT_CLASS && p.kind === 'slice' && !declared.has(p.host))
				stale.add(p.host);
		}
		let replaced = 0;
		for (const host of [...measuredHosts, ...stale]) {
			const m = mergeResidentRows(
				text,
				rows.filter((r) => r.host === host),
				host,
				{ kinds: ['slice'] }
			);
			text = m.text;
			replaced += m.replaced;
		}
		writeFileSync(path, text);
		writeResult = { path, written: rows.length, replaced, removedHosts: [...stale].sort() };
	}

	return {
		ok: findings.length === 0,
		at,
		declaredNodes: declared.size,
		rows,
		findings,
		write: writeResult,
	};
}
