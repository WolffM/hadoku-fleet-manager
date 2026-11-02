#!/usr/bin/env node
/**
 * fleet hosting-eligibility — per node, the tenants' repos that node may run
 * (fleet-manager#42), for hadoku_site's machine service grants: each machine
 * holds its own 7-day credential for each service identity it may run, and
 * the credential must be there before the service starts.
 *
 * What "eligible" means, and every reason the document is `ok: false`, is
 * lib/hosting-eligibility.mjs.
 *
 * READS ONLY, AND REACHES NO NODE. The ledger says where each tenant is placed
 * (fleet-hosting.json, drain records of `kind: hosting`); the converger's last
 * pass, which executed every tenant's rules on every claw five minutes ago at
 * most, says where it may go. The repo is the one the tenant's own hosting.json
 * was registered from (hosting-tenants.json), never a table typed here.
 *
 * EXIT: 0 when the document is ok, 1 when it says `ok: false` (something could
 * not be looked at; `error` says what), 2 on a usage error. Under --json the
 * document is on stdout in every case, and wins over the exit code.
 *
 * USAGE
 *   fleet hosting-eligibility --json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { readHostingDoc } from '../dist/runners/hosting-record.js';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';
import { HOSTING_ELIGIBILITY_CONTRACT, eligibilityDocument } from './lib/hosting-eligibility.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { readTenantRegistry } from './lib/tenant-registry.mjs';

const LAST_FILE = 'hosting-converge-last.json';

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log('fleet hosting-eligibility --json');
	out.log(
		'Per node, the repos it holds a slice of (placed) and may be given one of (eligible), for service grants.'
	);
	process.exit(0);
}
const NOW = Date.now();
for (const a of argv)
	if (a !== '--json') {
		out.warn(`hosting-eligibility: unexpected argument ${a}. See --help.`);
		out.emit({
			contract: HOSTING_ELIGIBILITY_CONTRACT,
			generatedAt: new Date(NOW).toISOString(),
			ok: false,
			error: `unexpected argument ${a}`,
			nodes: null,
		});
		process.exit(2);
	}

// Each source read once; one that cannot be read is carried as a reason, never as empty.
const problems = [];
const attempt = (what, read) => {
	try {
		return read();
	} catch (err) {
		problems.push(`${what} is unreadable: ${err.message}`);
		return null;
	}
};
const registry = attempt('the tenant registry (hosting-tenants.json)', () =>
	readTenantRegistry(stateDir())
);
const manifest = attempt('the fleet manifest', () => loadManifest());
const drainDoc = attempt('the drain record (fleet-drain.json)', () => readDrainDoc());
const hostingDoc = attempt('the hosting record (fleet-hosting.json)', () =>
	readHostingDoc(stateDir())
);
const lastPath = join(stateDir(), LAST_FILE);
let last = null;
if (!existsSync(lastPath))
	problems.push(`the converger has kept no pass (${LAST_FILE}), so no candidate is known`);
else
	last = attempt(`the converger's last pass (${LAST_FILE})`, () =>
		JSON.parse(readFileSync(lastPath, 'utf8'))
	);

const doc = eligibilityDocument({
	registry,
	manifest,
	drainDoc,
	hostingDoc,
	last,
	problems,
	now: NOW,
});

if (doc.nodes)
	for (const [node, row] of Object.entries(doc.nodes)) {
		out.log(`${node}: ${row.eligible.join(', ') || '(nothing)'}`);
		for (const u of row.unknown) out.log(`  ? ${u.repo}: ${u.why}`);
	}
for (const n of doc.notLent ?? []) out.log(`${n.node}: not lent (${n.role})`);
if (!doc.ok) out.log(`! ${doc.error}`);
out.emit(doc);
process.exit(doc.ok ? 0 : 1);
