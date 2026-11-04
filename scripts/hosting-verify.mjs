#!/usr/bin/env node
/**
 * fleet hosting-verify — every hosted tenant's home, checked from the node and
 * put back when it drifted (fleet-manager#31).
 *
 * ONE `fleet hosting --check --json`, then `fleet hosting <node> --tenant <t>
 * --reassert --json` for each slice that is not guaranteed and that the node
 * side can repair (lib/hosting-verify.mjs says which), then that re-assert's
 * own judgement of the node. Both through the door the operator runs: this
 * script decides nothing about a slice the door does not.
 *
 * src/hosting-verify.ts runs it hourly in mgmt-api and pages a slice the
 * re-assert did not make guaranteed (`unconverged`), once, then daily. A node
 * that did not answer is `unreadable`: logged, never paged here, because
 * node-status and the fast loop already page an unreachable node.
 *
 * USAGE
 *   fleet hosting-verify [--dry-run] [--json]
 *   --dry-run   check and plan only; re-asserts nothing
 *
 * It also sweeps EVERY node's pm2 daemons for a pm2 tenant's app under another
 * user (lib/hosting-pm2-strays.mjs, fleet-manager#43). A stray is unconverged
 * and never removed here: deleting a pm2 app is the operator's act.
 *
 * It also holds the TENANT REGISTRY to each app's shipped hosting.json
 * (lib/tenant-drift.mjs, 2026-11-04): a valid request that changed in the app
 * repo is re-registered, an invalid one is unconverged (the last valid copy
 * stands), so the registry is a cache of the repo and never a second truth.
 *
 * It also asks whether any service depends on one claw (lib/hosting-redundancy.mjs,
 * 2026-11-03): a service with no standby is an `advisories` entry; one that
 * asked for N standbys and has fewer guaranteed on other nodes is unconverged.
 *
 * EXIT 0 only when every slice is guaranteed or was made so, no node holds a
 * stray, and every service has the standbys it asked for.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { loadManifest, runOn, selectMachines } from './lib/fleet-exec.mjs';
import {
	judgeStrays,
	parseStrayObservation,
	STRAY_OBSERVE_SCRIPT,
} from './lib/hosting-pm2-strays.mjs';
import { shipped } from './lib/fleet-source.mjs';
import { judgeRedundancy } from './lib/hosting-redundancy.mjs';
import { judgeTenantDrift, repoOfSource } from './lib/tenant-drift.mjs';
import { planVerify } from './lib/hosting-verify.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { readHostingDoc } from '../dist/runners/hosting-record.js';
import { runFleetScript } from './lib/run-fleet-script.mjs';
import { readTenantRegistry, registerTenant, tenantSpecFrom } from './lib/tenant-registry.mjs';

const HOSTING = resolve(dirname(fileURLToPath(import.meta.url)), 'hosting.mjs');
/** A re-assert deploys and then checks one slice: two ssh round trips and a port probe. */
const REASSERT_TIMEOUT_MS = 5 * 60_000;

const args = process.argv.slice(2);
for (const a of args) {
	if (!['--dry-run', '--json', '--help', '-h'].includes(a)) {
		console.error(`hosting-verify: unknown argument ${a}. See --help.`);
		process.exit(2);
	}
}
const DRY_RUN = args.includes('--dry-run');
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

if (args.includes('--help') || args.includes('-h')) {
	log('fleet hosting-verify [--dry-run] [--json]');
	log('  check every hosted slice from its node; re-assert the ones not guaranteed.');
	process.exit(0);
}

/**
 * Every node's pm2 daemons, read at once. A node that did not answer and is
 * not expected down is `null`: "I could not look", never "no strays".
 */
async function sweepStrays() {
	const specs = Object.values(readTenantRegistry(stateDir()).tenants)
		.map((e) => tenantSpecFrom(e.request))
		.filter((t) => t.runtime === 'pm2');
	const drains = readDrains();
	const machines = selectMachines(loadManifest(), { where: (m) => m.placement !== 'excluded' });
	const observations = {};
	await Promise.all(
		machines.map(async ([name]) => {
			const r = await runOn(name, STRAY_OBSERVE_SCRIPT, { as: 'admin', timeoutMs: 30_000 });
			const parsed = r.ok ? parseStrayObservation(r.stdout) : null;
			if (!parsed && deferralFor(name, drains).deferred) return;
			observations[name] = parsed;
		})
	);
	return judgeStrays(specs, observations);
}

async function main() {
	const unreadable = [];
	const converged = [];
	const unconverged = [];
	const changed = [];
	const advisories = [];

	const check = await runFleetScript(HOSTING, ['--check', '--json'], { timeoutMs: 10 * 60_000 });
	const rows = Array.isArray(check.json?.nodes) ? check.json.nodes : null;
	if (!rows) {
		unreadable.push({ node: '*', facet: 'hosting', why: `fleet hosting --check: ${check.why}` });
	}
	const plan = planVerify(rows ?? [], Date.now());
	for (const u of plan.unreadable) unreadable.push({ node: u.node, facet: u.facet, why: u.before });
	for (const u of plan.unrepairable)
		unconverged.push({ ...u, why: `the node side cannot repair this: ${u.before}` });
	for (const l of plan.lapsed)
		log(`lapsed      ${l.node} ${l.facet}: past its end, --remove's to take away (${l.before})`);

	for (const item of plan.repair) {
		if (DRY_RUN) {
			log(`would re-assert ${item.node} ${item.facet}: ${item.before}`);
			continue;
		}
		const r = await runFleetScript(
			HOSTING,
			[item.node, '--tenant', item.tenant, '--reassert', '--json'],
			{ timeoutMs: REASSERT_TIMEOUT_MS }
		);
		if (r.json?.ok === true && r.json.state === 'guaranteed') {
			converged.push({ ...item, changed: 're-asserted' });
			changed.push({ node: item.node, facet: item.facet, changed: 're-asserted' });
			log(`converged   ${item.node} ${item.facet}: ${item.before}`);
		} else {
			const why =
				r.json?.reason ||
				(r.json?.findings ?? [])
					.filter((f) => f.class === 'blocking')
					.map((f) => `${f.category}: ${f.why}`)
					.join('; ') ||
				r.why;
			unconverged.push({ ...item, why });
			log(`unconverged ${item.node} ${item.facet}: ${why}`);
		}
	}
	let strays = null;
	try {
		const sweep = await sweepStrays();
		strays = sweep.strays;
		for (const u of sweep.unreadable)
			unreadable.push({ node: u.node, facet: 'hosting-pm2', why: u.why });
		for (const st of sweep.strays) {
			unconverged.push({
				node: st.node,
				tenant: st.tenant,
				facet: `hosting:${st.tenant}`,
				why: st.why,
			});
			log(`stray       ${st.node} hosting:${st.tenant}: ${st.why}`);
		}
	} catch (err) {
		unreadable.push({
			node: '*',
			facet: 'hosting-pm2',
			why: `the pm2 stray sweep failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	// THE REGISTRY AGAINST WHAT EACH APP SHIPS, before anything reads it below.
	try {
		for (const [app, entry] of Object.entries(readTenantRegistry(stateDir()).tenants)) {
			const facet = `tenant:${app}`;
			const repo = repoOfSource(entry.source);
			let text = null;
			if (repo) {
				try {
					text = shipped(repo).read('hosting.json');
				} catch (err) {
					unreadable.push({ node: '*', facet, why: `${repo}: ${err.reason ?? err.message}` });
					continue;
				}
			}
			const d = judgeTenantDrift(entry, text);
			if (d.verdict === 'unknown') {
				advisories.push({ node: '*', tenant: app, facet, category: 'tenant-source', why: d.why });
			} else if (d.verdict === 'invalid') {
				unconverged.push({ node: '*', tenant: app, facet, why: d.why });
				log(`unconverged * ${facet}: ${d.why}`);
			} else if (d.verdict === 'changed') {
				const what = `${entry.source} changed (${d.fields.join(', ')})`;
				if (DRY_RUN) {
					log(`would re-register ${app}: ${what}`);
				} else {
					registerTenant(stateDir(), d.request, { source: entry.source, by: 'hosting-verify' });
					changed.push({ node: '*', facet, changed: `re-registered: ${what}` });
					log(`re-registered ${app}: ${what}`);
				}
			}
		}
	} catch (err) {
		unreadable.push({
			node: '*',
			facet: 'tenant-registry',
			why: `the tenant registry could not be read: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	if (rows) {
		try {
			const r = judgeRedundancy(
				readTenantRegistry(stateDir()).tenants,
				readHostingDoc(stateDir()),
				rows,
				Date.now()
			);
			for (const f of r.findings) {
				unconverged.push(f);
				log(`unconverged ${f.node} ${f.facet}: ${f.why}`);
			}
			for (const a of r.advisories) {
				advisories.push(a);
				log(`advisory    ${a.node} ${a.facet}: ${a.why}`);
			}
		} catch (err) {
			unreadable.push({
				node: '*',
				facet: 'hosting-redundancy',
				why: `the tenant registry or hosting ledger could not be read: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	for (const u of unreadable) log(`unreadable  ${u.node} ${u.facet}: ${u.why}`);
	if (rows && !plan.repair.length && !unconverged.length && !unreadable.length)
		log(`✓ every hosted slice (${rows.length}) is guaranteed.`);

	const ok = unconverged.length === 0 && unreadable.length === 0;
	if (emitter.json)
		emitter.emit({
			ok,
			dryRun: DRY_RUN,
			slices: rows?.length ?? null,
			planned: plan.repair,
			converged,
			deferred: [],
			unconverged,
			unreadable,
			changed,
			strays,
			advisories,
		});
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`hosting-verify: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
