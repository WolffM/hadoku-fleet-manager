#!/usr/bin/env node
/**
 * fleet hosting-converge — meet each tenant's demand for slices, through the
 * `fleet hosting` door. fleet-manager#16; the decision is lib/hosting-converge.mjs.
 *
 * The controller runs this on its own timer (src/hosting-converge.ts) and pages
 * by the shared converger policy (src/scheduled-converger.ts). The operator
 * can run it by hand; `--dry-run` makes it decide and act on nothing.
 *
 * WHO IT ACTS FOR. Only a tenant whose registered hosting.json says
 * `placement.auto: true`, which the operator approves by registering it. For
 * every other tenant it reports, as `planned`, what it WOULD do, so the tenant
 * can compare that with its own judgement before turning auto on.
 *
 * ONE SWEEP. Offers are collected once per pass (one ssh per node) and every
 * tenant is decided against them. Each declare goes through the door, which
 * observes the node again and re-applies the tenant's placement before it
 * promises anything.
 *
 * The last full pass is kept in `hosting-converge-last.json` for
 * `fleet hosting-demand` to return to the tenant. A `--tenant` pass is not kept.
 *
 * USAGE
 *   fleet hosting-converge [--json] [--dry-run] [--tenant <app>]
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { drainNotices } from '../dist/runners/drain.js';
import { hostingNotices, hostingOn, readHostingDoc } from '../dist/runners/hosting-record.js';
import { collectOffers } from './lib/collect-offers.mjs';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';
import { act, decide } from './lib/hosting-converge.mjs';
import { readArtifact } from './lib/hosting-artifacts.mjs';
import { readDemand } from './lib/hosting-demand.mjs';
import { planFor } from './lib/hosting-plan.mjs';
import { PKG_SCRIPTS, siteRoot, stateDir } from './lib/paths.mjs';
import { spawnCapture } from './lib/spawn-json.mjs';
import { appLayerHost, readSiteDocs } from './lib/service-tunnels.mjs';
import { readTenantRegistry } from './lib/tenant-registry.mjs';

export const LAST_FILE = 'hosting-converge-last.json';
const DOOR_TIMEOUT_MS = 5 * 60_000;

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log('fleet hosting-converge [--json] [--dry-run] [--tenant <app>]');
	out.log(
		"Meets each tenant's slice demand. Acts only for placement.auto tenants; plans for the rest."
	);
	process.exit(0);
}
const DRY_RUN = argv.includes('--dry-run');
const onlyAt = argv.indexOf('--tenant');
const ONLY = onlyAt > -1 ? argv[onlyAt + 1] : null;
const NOW = Date.now();

const doc = {
	ok: true,
	planned: [],
	converged: [],
	deferred: [],
	unconverged: [],
	unreadable: [],
	changed: [],
	tenants: {},
};
const finish = () => {
	doc.ok = doc.unconverged.length === 0 && doc.unreadable.length === 0;
	for (const r of doc.changed) out.log(`  ${r.node} ${r.facet}: ${r.changed}`);
	for (const r of doc.planned)
		out.log(`  would: ${r.node} ${r.facet} ${r.changed} — ${r.why ?? r.before}`);
	for (const r of [...doc.deferred, ...doc.unconverged])
		out.log(`  ! ${r.node} ${r.facet}: ${r.why}`);
	for (const r of doc.unreadable) out.log(`  ? ${r.node} ${r.facet}: ${r.why}`);
	out.emit(doc);
	process.exit(doc.ok ? 0 : 1);
};

let registry, demand, drainDoc, hostingDoc, manifest;
try {
	registry = readTenantRegistry(stateDir());
	demand = readDemand(stateDir());
	drainDoc = readDrainDoc();
	hostingDoc = readHostingDoc(stateDir());
	manifest = loadManifest();
} catch (err) {
	// Could not look: every tenant's facet is unreadable, so nothing recovers on it.
	doc.unreadable.push({
		node: '*',
		facet: 'hosting',
		why: `cannot read fleet state: ${err.message}`,
	});
	finish();
}

const tenants = Object.entries(registry.tenants).filter(([app]) => !ONLY || app === ONLY);
if (ONLY && !tenants.length) {
	doc.unreadable.push({
		node: '*',
		facet: `hosting:${ONLY}`,
		why: `${ONLY} is not a registered tenant`,
	});
	finish();
}

// One sweep for every tenant, so it executes every tenant's tools.
const tools = [...new Set(tenants.flatMap(([, t]) => t.request.runtime?.tools ?? []))];
const { offers } = await collectOffers(manifest, { tools });
// The app layer's placement, for a service's first slice. Read once; unreadable is carried, not swallowed.
let siteDocs = null;
let siteWhy = null;
try {
	siteDocs = readSiteDocs(siteRoot());
} catch (err) {
	siteWhy = err.message;
}
const notices = [...drainNotices(drainDoc, NOW), ...hostingNotices(hostingDoc, NOW)];
const nodes = Object.keys(manifest.machines ?? {});

/** The door, spawned as the operator would run it. Its stdout is kept whole under --json. */
const door = async (args) => {
	try {
		const r = spawnCapture(
			process.execPath,
			[join(PKG_SCRIPTS, 'hosting.mjs'), ...args, '--json'],
			{
				timeout: DOOR_TIMEOUT_MS,
				label: `fleet hosting ${args.join(' ')}`,
			}
		);
		try {
			return { doc: JSON.parse(r.out), why: '' };
		} catch {
			return {
				doc: null,
				why: `exit ${r.code}, no report: ${r.err.trim().split('\n').at(-1) ?? ''}`,
			};
		}
	} catch (err) {
		return { doc: null, why: err.message.split('\n')[0] };
	}
};

for (const [app, { request }] of tenants) {
	const facet = `hosting:${app}`;
	const slices = nodes.flatMap((n) => {
		const h = hostingOn(n, drainDoc, hostingDoc, NOW);
		return h?.tenant === app
			? [{ node: n, ...(h.role ? { role: h.role } : {}), ...(h.until ? { until: h.until } : {}) }]
			: [];
	});
	// A slice past its end still has units until --remove. Whole-box ends are drains.
	const removeDue = [
		...Object.entries(hostingDoc.nodes),
		...Object.entries(drainDoc.nodes)
			.filter(([, r]) => r.kind === 'hosting')
			.map(([n, r]) => [n, { ...r.hosting, until: r.until }]),
	]
		.filter(
			([, r]) =>
				r.tenant === app && Number.isFinite(Date.parse(r.until ?? '')) && Date.parse(r.until) <= NOW
		)
		.map(([n]) => n);
	const plan = planFor(request, offers);
	const movePlan = request.availability.singleton
		? planFor({ ...request, slices: { ...request.slices, max: request.slices.max + 1 } }, offers)
		: null;
	const decision = decide({
		request,
		demand: demand.tenants[app] ?? null,
		plan,
		movePlan,
		offers,
		slices,
		removeDue,
		notices,
		now: NOW,
		appLayer:
			request.kind !== 'service'
				? null
				: siteDocs
					? { node: appLayerHost(app, siteDocs) }
					: { unreadable: siteWhy },
	});
	const live = request.placement.auto === true && !DRY_RUN;
	const { rows, results } = await act(request, decision, {
		live,
		door,
		artifact: request.kind === 'agent' ? readArtifact(stateDir(), app) : null,
	});
	for (const k of Object.keys(rows)) doc[k].push(...rows[k]);
	// A held slice on a node that did not answer: its facet is not read clean this pass.
	for (const u of [...decision.unplaceable, ...(decision.standby?.unplaceable ?? [])].filter(
		(x) => !x.reachable
	))
		doc.unreadable.push({ node: u.node, facet, why: u.why });
	doc.tenants[app] = {
		auto: request.placement.auto === true,
		live,
		demand: demand.tenants[app] ?? null,
		...decision,
		results,
	};
}

// Only a pass over every tenant replaces the kept one: a `--tenant` run would erase the rest.
if (!ONLY)
	try {
		const p = join(stateDir(), LAST_FILE);
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(
			`${p}.tmp`,
			`${JSON.stringify({ at: new Date(NOW).toISOString(), dryRun: DRY_RUN, tenants: doc.tenants }, null, 2)}\n`
		);
		renameSync(`${p}.tmp`, p);
	} catch (err) {
		out.warn(`could not keep this pass for hosting-demand: ${err.message}`);
	}
finish();
