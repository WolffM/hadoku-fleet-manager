#!/usr/bin/env node
/**
 * fleet hosting-demand — a tenant says how many slices it wants now.
 * fleet-manager#16, agreed with cardtable 2026-10-28; the record is
 * lib/hosting-demand.mjs, and `fleet hosting-converge` meets it.
 *
 * CALLED BY A PROGRAM, every poll. Restating the same N is a no-op apart from
 * `askedAt`. Every call, with or without `--slices`, returns the converger's
 * view of the tenant: what is declared, what is ending, what the last pass
 * decided and whether it acted (`live`) or only planned. One document on
 * stdout under `--json`; exit 0 only when the ask was recorded (or, with no
 * `--slices`, when the view was read).
 *
 * USAGE
 *   fleet hosting-demand <app> --slices N [--release-order node,node] [--json]
 *   fleet hosting-demand <app> [--json]          the view only
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { hostingOn, readHostingDoc } from '../dist/runners/hosting-record.js';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';
import { readArtifact } from './lib/hosting-artifacts.mjs';
import { demandProblems, readDemand, tenantSlices, writeDemand } from './lib/hosting-demand.mjs';
import { stateDir } from './lib/paths.mjs';
import { readTenantRegistry } from './lib/tenant-registry.mjs';

/** The view's version, pinned by the tenant like node-status's. Additive changes only. */
export const HOSTING_DEMAND_CONTRACT = 1;
const LAST_FILE = 'hosting-converge-last.json';

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h') || !argv[0] || argv[0].startsWith('--')) {
	out.log('fleet hosting-demand <app> --slices N [--release-order node,node] [--json]');
	out.log('fleet hosting-demand <app> [--json]   the converger view only');
	process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}
const app = argv[0];
const valueOf = (flag) => {
	const i = argv.indexOf(flag);
	return i > -1 ? argv[i + 1] : undefined;
};
const NOW = Date.now();
const iso = new Date(NOW).toISOString();

const agentView = (a) =>
	a === null
		? { kept: false }
		: a.ok
			? { kept: true, sha256: a.sha256 }
			: { kept: false, why: a.why };

const finish = (ok, fields) => {
	if (!ok) out.warn(`hosting-demand: ${fields.reason}`);
	out.emit({ contract: HOSTING_DEMAND_CONTRACT, ok, app, at: iso, ...fields });
	process.exit(ok ? 0 : 1);
};

let request, manifest, drainDoc, hostingDoc;
try {
	request = readTenantRegistry(stateDir()).tenants[app]?.request;
	manifest = loadManifest();
	drainDoc = readDrainDoc();
	hostingDoc = readHostingDoc(stateDir());
} catch (err) {
	finish(false, { reason: `cannot read fleet state: ${err.message}` });
}
if (!request)
	finish(false, {
		reason: `${app} is not a registered tenant. Register its hosting.json first: fleet hosting-request <owner/repo> --register.`,
	});

let recorded = null;
if (valueOf('--slices') !== undefined) {
	const slices = Number(valueOf('--slices'));
	const order = valueOf('--release-order');
	const releaseOrder = order
		? order
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	const problems = demandProblems(request, slices, releaseOrder);
	if (problems.length) finish(false, { reason: problems.join('; ') });
	try {
		recorded = writeDemand(
			stateDir(),
			app,
			{ slices, releaseOrder, by: process.env.SUDO_USER || process.env.USER || 'unknown' },
			iso
		);
	} catch (err) {
		finish(false, { reason: `could not record the demand: ${err.message}` });
	}
}

// What is declared now, from the records the converger and the door both read.
const { declared, ending } = tenantSlices(app, Object.keys(manifest.machines ?? {}), (node) =>
	hostingOn(node, drainDoc, hostingDoc, NOW)
);

let lastPass = null;
const lastPath = join(stateDir(), LAST_FILE);
if (existsSync(lastPath)) {
	try {
		const last = JSON.parse(readFileSync(lastPath, 'utf8'));
		lastPass = last.tenants?.[app]
			? { at: last.at, dryRun: last.dryRun, ...last.tenants[app] }
			: null;
	} catch (err) {
		out.warn(`${lastPath} is unreadable (${err.message}); no last pass to report`);
	}
}

let demand;
try {
	demand = readDemand(stateDir()).tenants[app] ?? null;
} catch (err) {
	finish(false, { reason: `the demand record is unreadable: ${err.message}` });
}
finish(true, {
	recorded: recorded ? { changed: recorded.changed } : null,
	demand,
	limits: { min: request.slices.min, max: request.slices.max },
	auto: request.placement.auto === true,
	declared,
	ending,
	// What the converger decided on its last pass, and did (`live`) or only planned.
	lastPass,
	// An agent tenant: the artifact the converger installs on every slice it
	// declares. Not kept = a declared slice waits for the tenant's first install.
	...(request.kind === 'agent' ? { agent: agentView(readArtifact(stateDir(), app)) } : {}),
});
