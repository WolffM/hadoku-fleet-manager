#!/usr/bin/env node
/**
 * fleet hosting-placement — where the fleet has placed an app, for the app's
 * deploy to follow (fleet-manager#16). hadoku_site's deploy of a
 * `"placement": "fleet"` row reads `placement.nodes[0]` here in place of a
 * hand-set `host` (hadoku_site#491 part 2), and refuses while `moving`.
 *
 * What the document says, and from where, is lib/hosting-placement-view.mjs.
 * This file reads the records and probes the app's own slices, one ssh per
 * slice node (the same check `fleet hosting --check` runs, lib/hosting-check.mjs),
 * never the whole fleet. Offers come from the converger's last pass.
 *
 * READS ONLY. Nothing here declares, ends or moves anything; the record's one
 * writer is the `fleet hosting` door. The one file it writes is its own
 * per-app copy for `--max-age`.
 *
 * EXIT: 0 when the document is ok, 1 when it says `ok: false` (something could
 * not be looked at; `error` says what), 2 on a usage error or an app that is
 * not a registered tenant. Under --json the document is on stdout in every
 * case, and wins over the exit code.
 *
 * USAGE
 *   fleet hosting-placement <app> --json [--max-age <sec>]
 *   fleet hosting-placement --json            every registered tenant, under apps[]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../dist/lib/atomic-json.js';
import { drainNotices } from '../dist/runners/drain.js';
import { hostingNotices, readHostingDoc } from '../dist/runners/hosting-record.js';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { checkSlice } from './lib/hosting-check.mjs';
import { readDemand } from './lib/hosting-demand.mjs';
import {
	HOSTING_PLACEMENT_CONTRACT,
	appRecords,
	placementDocument,
} from './lib/hosting-placement-view.mjs';
import { stateDir } from './lib/paths.mjs';
import { readTenantRegistry, tenantSpec } from './lib/tenant-registry.mjs';

const LAST_FILE = 'hosting-converge-last.json';
const CACHE_DIR = 'hosting-placement-last';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const out = createEmitter({ json: JSON_OUT });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log('fleet hosting-placement [<app>] --json [--max-age <sec>]');
	out.log(
		"Where the fleet placed an app: { state, epoch, nodes, target }, and each slice's state."
	);
	process.exit(0);
}
const maxAgeAt = argv.indexOf('--max-age');
const MAX_AGE_S = maxAgeAt > -1 ? Number(argv[maxAgeAt + 1]) : null;
const positional = argv.filter(
	(a, i) => !a.startsWith('-') && !(maxAgeAt > -1 && i === maxAgeAt + 1)
);
const APP = positional[0] ?? null;
const NOW = Date.now();

/** Every non-document exit: one `{ ok: false }` with the reason, still a document. */
function refuse(code, error) {
	out.warn(`hosting-placement: ${error}`);
	out.emit({
		contract: HOSTING_PLACEMENT_CONTRACT,
		generatedAt: new Date(NOW).toISOString(),
		cached: false,
		ok: false,
		app: APP,
		error,
	});
	process.exit(code);
}

for (const a of argv)
	if (a.startsWith('-') && !['--json', '--max-age'].includes(a))
		refuse(2, `unknown flag ${a}. See --help.`);
if (positional.length > 1) refuse(2, `one app at most; got ${positional.join(', ')}`);
if (MAX_AGE_S !== null && !(MAX_AGE_S > 0))
	refuse(2, '--max-age takes a number of seconds above 0');
if (MAX_AGE_S !== null && !APP) refuse(2, '--max-age is per app: name one');

let registry;
try {
	registry = readTenantRegistry(stateDir());
} catch (err) {
	refuse(1, `the tenant registry is unreadable: ${err.message}`);
}
if (APP && !registry.tenants[APP])
	refuse(
		2,
		`${APP} is not a registered tenant (registered: ${Object.keys(registry.tenants).join(', ') || 'none'})`
	);
const apps = APP ? [APP] : Object.keys(registry.tenants).sort();
if (!apps.length) refuse(1, 'no tenant is registered, so there is no placement to read');

// A per-app copy, served while younger than --max-age. Its own generatedAt stays.
const cachePath = APP ? join(stateDir(), CACHE_DIR, `${APP}.json`) : null;
if (MAX_AGE_S !== null && existsSync(cachePath)) {
	let last = null;
	try {
		last = JSON.parse(readFileSync(cachePath, 'utf8'));
	} catch (err) {
		out.warn(`${cachePath} is unreadable (${err.message}); answering live.`);
	}
	if (
		last?.contract === HOSTING_PLACEMENT_CONTRACT &&
		NOW - Date.parse(last.generatedAt) <= MAX_AGE_S * 1000
	) {
		out.emit({ ...last, cached: true });
		process.exit(last.ok ? 0 : 1);
	}
}

// Each source read once; one that cannot be read is carried as a reason, never as empty.
const problems = [];
const attempt = (what, read, fallback) => {
	try {
		return read();
	} catch (err) {
		problems.push(`${what} is unreadable: ${err.message}`);
		return fallback;
	}
};
const manifest = attempt('the fleet manifest', () => loadManifest(), null);
const drainDoc = attempt('the drain record (fleet-drain.json)', () => readDrainDoc(), null);
const hostingDoc = attempt(
	'the hosting record (fleet-hosting.json)',
	() => readHostingDoc(stateDir()),
	null
);
const demand = attempt(
	'the demand record (hosting-demand.json)',
	() => readDemand(stateDir()),
	null
);
const lastPath = join(stateDir(), LAST_FILE);
const last = existsSync(lastPath)
	? attempt(
			`the converger's last pass (${LAST_FILE})`,
			() => JSON.parse(readFileSync(lastPath, 'utf8')),
			null
		)
	: null;
const notices =
	drainDoc && hostingDoc
		? [...drainNotices(drainDoc, NOW), ...hostingNotices(hostingDoc, NOW)]
		: [];

const docs = [];
for (const app of apps) {
	const records = drainDoc && hostingDoc ? appRecords(app, drainDoc, hostingDoc, NOW) : null;
	const probes = new Map();
	const appProblems = [...problems];
	if (records && manifest) {
		const ctx = {
			manifest,
			hostingDoc,
			specOf: (t) => tenantSpec(registry, t),
			run: runOn,
		};
		await Promise.all(
			records
				.filter((r) => !r.lapsed)
				.map(async (r) => {
					const result = await checkSlice(ctx, {
						name: r.node,
						mode: r.mode,
						declared: {
							tenant: app,
							...r.declared,
							...(r.role === 'standby' ? { role: 'standby' } : {}),
						},
						until: r.until,
					});
					probes.set(r.node, { ...result, observedAt: new Date().toISOString() });
				})
		);
	} else if (records && !manifest) {
		appProblems.push(`${app}'s slices were not probed: the manifest names no node to reach`);
	}
	docs.push(
		placementDocument({
			app,
			request: registry.tenants[app].request,
			records,
			appRec: hostingDoc?.apps?.[app],
			probes,
			notices,
			demand: demand?.tenants?.[app] ?? null,
			last,
			problems: appProblems,
			now: NOW,
		})
	);
}

for (const d of docs) {
	const p = d.placement;
	out.log(
		p
			? `${d.app}: ${p.state}${p.nodes.length ? ` on ${p.nodes.join(', ')}` : ''}${p.target ? ` → ${p.target}` : ''}, epoch ${p.epoch}`
			: `${d.app}: could not read its placement`
	);
	for (const s of d.slices) out.log(`  ${s.node} ${s.role} ${s.state}${s.why ? `: ${s.why}` : ''}`);
	if (!d.ok) out.log(`  ! ${d.error}`);
}

if (APP) {
	const [doc] = docs;
	try {
		mkdirSync(join(stateDir(), CACHE_DIR), { recursive: true });
		writeJsonAtomic(cachePath, doc);
	} catch (err) {
		out.warn(`could not keep the document for --max-age: ${err.message}`);
	}
	out.emit(doc);
	process.exit(doc.ok ? 0 : 1);
}
const ok = docs.every((d) => d.ok);
out.emit({
	contract: HOSTING_PLACEMENT_CONTRACT,
	generatedAt: new Date(NOW).toISOString(),
	cached: false,
	ok,
	apps: docs,
});
process.exit(ok ? 0 : 1);
