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
 * EXIT 0 only when every slice is guaranteed or was made so.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmitter } from './lib/emit.mjs';
import { planVerify } from './lib/hosting-verify.mjs';
import { runFleetScript } from './lib/run-fleet-script.mjs';

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

async function main() {
	const unreadable = [];
	const converged = [];
	const unconverged = [];
	const changed = [];

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
		});
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`hosting-verify: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
