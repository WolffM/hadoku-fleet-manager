#!/usr/bin/env node
/**
 * fleet hosting — lend a node to a tenant's resident service, with CI held off.
 *
 * What a hosting node IS, and why each fact is written and read where it is,
 * is in `lib/hosting.mjs`. This file is the door: declare, end, remove, check.
 *
 * ORDER ON DECLARE: the drain record FIRST, then the units. CI comes off the
 * box before the tenant's agent can start beside it — a CI job on a public
 * repo's self-hosted runner could otherwise read a live match's hidden cards
 * from /proc. A deploy that then fails leaves a node with no CI and a
 * blocking finding, which is the honest state.
 *
 * ENDING IS TWO STEPS, because the tenant is owed notice. `--end --in 30m`
 * schedules the hosting record's lapse (at least HOSTING_NOTICE_MS ahead
 * unless `--force`), and `fleet node-status --json` shows it coming. At that
 * moment CI may return. `--remove` then takes the units and the port away; it
 * refuses while the end is still ahead, so the agent is never pulled out from
 * under live work by surprise.
 *
 * USAGE
 *   fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6
 *   fleet hosting claw-8 --end --in 30m
 *   fleet hosting claw-8 --remove
 *   fleet hosting --check [--json]
 */
import process from 'node:process';

import { HOSTING_NOTICE_MS, noticeRefusal, parseWhen } from '../dist/runners/drain.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc, writeDrainDoc } from './lib/expected-down.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import {
	CONTROLLER_NODE,
	TENANTS,
	deployScript,
	fitProblems,
	judgeHosting,
	observeScript,
	parseCores,
	parseMemoryMb,
	parseObserved,
	removeScript,
} from './lib/hosting.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : (args[i + 1] ?? null);
};
const VALUE_FLAGS = ['--tenant', '--memory', '--cores', '--reason', '--in', '--at'];
const node = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
const out = createEmitter();

if (has('--help') || has('-h')) {
	out.log(
		[
			'fleet hosting <node> --tenant <name> --memory 12G --cores 6 [--reason "why"]',
			'        lend the node: CI off, resources served from a slice, agent supervised,',
			'        one LAN port open to the controller.',
			'fleet hosting <node> --end (--in 30m | --at <iso>) [--force]',
			`        schedule the end; the tenant is owed ${HOSTING_NOTICE_MS / 60_000} min notice.`,
			'fleet hosting <node> --remove [--force]',
			'        take the units and the port away once the end has passed.',
			'fleet hosting --check [--json]',
			'        declared vs observed, from the kernel, for every hosting node.',
			'',
			`tenants: ${Object.entries(TENANTS)
				.map(([n, t]) => `${n} (port ${t.port}, agent ~/${t.exec})`)
				.join(', ')}`,
		].join('\n')
	);
	process.exit(0);
}

const NOW = Date.now();
const manifest = loadManifest();
const doc = readDrainDoc();
const by = process.env.SUDO_USER || process.env.USER || 'unknown';

/** The controller's reserved LAN address — the only source the port is opened to. */
function controllerIp() {
	const ip = manifest.machines?.[CONTROLLER_NODE]?.lan?.ip;
	if (!ip) {
		fail(
			`machines.${CONTROLLER_NODE}.lan.ip is not recorded, so there is no address to open the ` +
				'port to. Record the reservation first (`fleet preflight` names it).'
		);
	}
	return ip;
}

function fail(why) {
	console.error(`hosting: ${why}`);
	process.exit(1);
}

async function observe(name, tenant) {
	const r = await runOn(name, observeScript(tenant), { timeoutMs: 30_000, connectTimeout: 6 });
	return { obs: parseObserved(r.stdout), error: r.ok ? null : (r.error ?? r.stderr.trim()) };
}

/** Every node whose CURRENT record is hosting — lapsed or not, so a lapsed one is still checked. */
const hostingNodes = () => Object.entries(doc.nodes).filter(([, r]) => r.kind === 'hosting');

if (has('--check')) {
	const rows = [];
	for (const [name, rec] of hostingNodes()) {
		const { obs, error } = await observe(name, rec.hosting?.tenant);
		const judged = judgeHosting(rec.hosting ?? {}, obs);
		if (!obs && error) judged.findings[0].why += ` (${error})`;
		rows.push({ node: name, declared: rec.hosting ?? null, until: rec.until ?? null, ...judged });
	}
	const blocking = rows.flatMap((r) => r.findings.filter((f) => f.class === 'blocking'));
	for (const r of rows) {
		out.log(
			`── ${r.node}  ${r.declared?.tenant ?? '?'}  ${r.findings.length ? '' : 'serving as declared'}`
		);
		for (const f of r.findings) out.log(`   ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
	}
	if (!rows.length) out.log('no node is hosting.');
	if (out.json) out.emit({ ok: blocking.length === 0, hosting: rows.length, nodes: rows });
	process.exit(blocking.length ? 1 : 0);
}

if (!node) fail('name a node, or use --check. See --help.');
const machine = manifest.machines?.[node];
if (!machine) fail(`${node} is not a declared node.`);
if (isGuestNode(machine)) {
	fail(
		`${node} is a guest. A guest lends the fleet a registration and nothing else; it is not lent onward.`
	);
}
const current = doc.nodes[node];

if (has('--end')) {
	if (current?.kind !== 'hosting') fail(`${node} is not hosting.`);
	const spec = valueOf('--at') ?? valueOf('--in');
	if (!spec) fail('--end needs --in <duration> or --at <iso>.');
	let endMs;
	try {
		endMs = parseWhen(spec, NOW);
	} catch (err) {
		fail(err.message);
	}
	const refusal = noticeRefusal(node, endMs, doc, NOW);
	if (refusal && !has('--force'))
		fail(`${refusal}\n  Use --in 15m or later, or --force if the box is failing.`);
	writeDrainDoc({
		nodes: { ...doc.nodes, [node]: { ...current, until: new Date(endMs).toISOString() } },
		planned: doc.planned,
	});
	console.log(`✓ ${node} stops hosting at ${new Date(endMs).toISOString()}; CI may return then.`);
	console.log(`  Then: fleet hosting ${node} --remove`);
	process.exit(0);
}

if (has('--remove')) {
	if (current && current.kind !== 'hosting')
		fail(`${node} is drained as '${current.kind}', not hosting.`);
	const endMs = Date.parse(current?.until ?? '');
	if (current && !(endMs <= NOW) && !has('--force')) {
		fail(
			current.until
				? `${node} hosts until ${current.until}. Remove it after that, or --force.`
				: `${node} has no end scheduled. Run --end --in 30m first, so the tenant sees it coming.`
		);
	}
	const tenant = current?.hosting?.tenant ?? valueOf('--tenant');
	if (!TENANTS[tenant]) fail(`which tenant? Pass --tenant (${Object.keys(TENANTS).join(', ')}).`);
	const r = await runOn(node, removeScript(tenant, controllerIp()), { timeoutMs: 60_000 });
	if (!r.stdout.includes('HOSTING-REMOVED')) {
		fail(
			`teardown on ${node} did not finish: ${r.error ?? r.stderr.trim()}. The record is kept, so CI stays off.`
		);
	}
	const nodes = { ...doc.nodes };
	if (current) delete nodes[node];
	writeDrainDoc({ nodes, planned: doc.planned });
	console.log(
		`✓ ${node} is no longer hosting; units removed and port ${TENANTS[tenant].port} closed.`
	);
	console.log('  The fast loop restores its label on the next tick.');
	process.exit(0);
}

// ── declare ──────────────────────────────────────────────────────────────────
const tenant = valueOf('--tenant');
if (!TENANTS[tenant]) fail(`--tenant must be one of ${Object.keys(TENANTS).join(', ')}.`);
let resources;
try {
	resources = {
		memoryMb: parseMemoryMb(valueOf('--memory')),
		cores: parseCores(valueOf('--cores')),
	};
} catch (err) {
	fail(err.message);
}
if (current && !['hosting', 'lease'].includes(current.kind) && !has('--force')) {
	fail(
		`${node} is drained as '${current.kind ?? 'maintenance'}' (${current.reason}). ` +
			'Somebody took it out for a reason; --force if hosting should replace that.'
	);
}
const ip = controllerIp();

// The node's own measurement, never the manifest's rounded ramGb.
const before = await observe(node, tenant);
if (!before.obs) fail(`could not observe ${node}: ${before.error ?? 'no answer'}`);
const misfit = fitProblems(resources, before.obs, machine.minFreeMb ?? 1024);
if (misfit.length) fail(`the declaration does not fit ${node}:\n  ${misfit.join('\n  ')}`);

const record = {
	since: current?.kind === 'hosting' ? current.since : new Date(NOW).toISOString(),
	kind: 'hosting',
	reason: valueOf('--reason') ?? `${tenant} hosting node`,
	by,
	hosting: { tenant, ...resources, port: TENANTS[tenant].port },
};
writeDrainDoc({ nodes: { ...doc.nodes, [node]: record }, planned: doc.planned });
console.log(`✓ ${node} is a ${tenant} hosting node; CI is held off from the next fast-loop tick.`);

const r = await runOn(node, deployScript(tenant, resources, ip), { timeoutMs: 120_000 });
if (!r.stdout.includes('HOSTING-DEPLOYED')) {
	fail(
		`deploy on ${node} did not finish: ${r.error ?? r.stderr.trim()}. CI stays off; re-run to finish.`
	);
}
const after = await observe(node, tenant);
const { observed, findings } = judgeHosting(record.hosting, after.obs);
console.log(
	`  served:  ${observed?.memoryMb ?? '?'} MiB, ${observed?.cores ?? '?'} cores, swap ${observed?.swapMb ?? '?'}`
);
console.log(
	`  agent:   ${observed?.agent ?? '?'} (port ${TENANTS[tenant].port}, ~/${TENANTS[tenant].exec})`
);
for (const f of findings) console.log(`  ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
if (findings.some((f) => f.class === 'blocking')) {
	console.log(
		'  Running CI jobs finish first (a drain never kills one); check again with `fleet hosting --check`.'
	);
}
