#!/usr/bin/env node
/**
 * fleet hosting — lend a node to a tenant's resident service.
 *
 * What a hosting node IS, and why each fact is written and read where it is,
 * is in `lib/hosting.mjs` (the node) and src/runners/hosting-record.ts (the
 * shared record and its priority). This file is the door.
 *
 * CALLED BY A PROGRAM (cardtable §8). Cardtable's coordinator declares and
 * ends slices unattended. So every action takes `--json`, prints ONE document
 * on stdout whether it succeeds or not, and exits 0 only when the action was
 * done: `{ ok, action, node, state, reason, ... }`.
 *
 * TWO MODES:
 *   whole     CI held off the node (a drain of `kind: 'hosting'`). ORDER ON
 *             DECLARE: the drain record FIRST, then the units, so the agent
 *             never starts beside CI.
 *   --shared  CI keeps the node and ranks below the slice. The record goes in
 *             `fleet-hosting.json` FIRST, so the dispatcher holds back the
 *             slice's memory from its next pass (`admissionFrom`), before the
 *             agent can start.
 *
 * ENDING IS TWO STEPS, because the tenant is owed notice. `--end --in 30m`
 * schedules the end (at least HOSTING_NOTICE_MS ahead unless `--force`), and
 * `fleet node-status --json` shows it coming. `--remove` then takes the units,
 * the executable and the port away. It refuses while the end is still ahead.
 * `--keep` takes a scheduled end back while the units are still there, past
 * the end included: the tenant asked for the slice again before `--remove`
 * ran. It only ever gives the tenant more, so it owes no notice.
 *
 * USAGE
 *   fleet hosting claw-9 --tenant cardtable --memory 4G --cores 4 --shared
 *   fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6      # whole box
 *   fleet hosting claw-9 --install ./run --sha256 <hex>
 *   fleet hosting claw-9 --restart
 *   fleet hosting claw-9 --end --in 30m
 *   fleet hosting claw-9 --keep
 *   fleet hosting claw-9 --remove
 *   fleet hosting claw-9 --ci-shaped [--wait] -- <command>
 *   fleet hosting --check
 *   (every action takes --json)
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

import { HOSTING_NOTICE_MS, noticeRefusal, parseWhen } from '../dist/runners/drain.js';
import { hostingOn, readHostingDoc, writeHostingDoc } from '../dist/runners/hosting-record.js';
import { stateDir } from './lib/paths.mjs';
import { readTenantRegistry, tenantSpec } from './lib/tenant-registry.mjs';
import { isGuestNode } from '../dist/lib/node-role.js';
import { nodeUser } from '../dist/lib/node-users.js';
import { readDrainDoc, writeDrainDoc } from './lib/expected-down.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { collectOffers } from './lib/collect-offers.mjs';
import { keepArtifact } from './lib/hosting-artifacts.mjs';
import { planFor } from './lib/hosting-plan.mjs';
import {
	CONTROLLER_NODE,
	INSTALL_MAX_BYTES,
	NO_TENANT,
	ciShapedScript,
	deployScript,
	fitProblems,
	installScript,
	judgeHosting,
	leftoversScript,
	observeScript,
	parseCores,
	parseMemoryMb,
	parseLeftovers,
	parseObserved,
	peerCandidates,
	probeReach,
	removeScript,
	restartScript,
} from './lib/hosting.mjs';

const dashdash = process.argv.indexOf('--');
const args = process.argv.slice(2, dashdash === -1 ? undefined : dashdash);
const tail = dashdash === -1 ? [] : process.argv.slice(dashdash + 1);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : (args[i + 1] ?? null);
};
const VALUE_FLAGS = [
	'--tenant',
	'--memory',
	'--cores',
	'--reason',
	'--in',
	'--at',
	'--install',
	'--sha256',
	'--role',
];
const BOOL_FLAGS = [
	'--shared',
	'--end',
	'--keep',
	'--remove',
	'--check',
	'--restart',
	'--reassert',
	'--ci-shaped',
	'--wait',
	'--force',
	'--json',
	'--help',
	'-h',
];
const JSON_OUT = has('--json');
// One document through a pipe, whole, even though it is printed just before exit (#33).
if (JSON_OUT) keepStdoutWhole();

// A typo must never reach a default that changes things (6449082).
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (VALUE_FLAGS.includes(a)) i++;
	else if (a.startsWith('-') && !BOOL_FLAGS.includes(a)) {
		console.error(`hosting: unknown flag ${a}. See --help.`);
		process.exit(2);
	}
}
const node = args.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(args[i - 1]));

if (has('--help') || has('-h')) {
	console.log(
		[
			'fleet hosting <node> --tenant <name> --memory 4G --cores 4 [--shared] [--role standby] [--reason "why"]',
			'        lend the node. --shared: CI stays and ranks below the slice; without it CI is held off.',
			"        --role standby: one of the tenant's availability.standby copies (docs/service-state.md).",
			'fleet hosting <node> --install <path> --sha256 <hex>',
			"        put the tenant's executable in place, root-owned, and restart the agent.",
			'fleet hosting <node> --restart',
			'        restart the agent (after it upgraded itself).',
			'fleet hosting <node> --reassert',
			'        re-run the node side of the slice it holds, from its record; the record is not touched.',
			'fleet hosting <node> --end (--in 30m | --at <iso>) [--force]',
			`        schedule the end; the tenant is owed ${HOSTING_NOTICE_MS / 60_000} min notice.`,
			'fleet hosting <node> --keep',
			'        take a scheduled end back, while the units are still there.',
			'fleet hosting <node> --remove [--force]',
			'        take the units, executable and port away once the end has passed.',
			'fleet hosting <node> --ci-shaped [--wait] -- <command>',
			'        run <command> contained exactly as a CI job is, with no GitHub job (tests).',
			'fleet hosting --check',
			'        declared vs observed, from the kernel, for every hosting node.',
			'Every action takes --json: one document on stdout, exit 0 only when it was done.',
			'',
			'tenants: every request registered with `fleet hosting-request <repo> --register`.',
		].join('\n')
	);
	process.exit(0);
}

const NOW = Date.now();
const action = has('--check')
	? 'check'
	: has('--install')
		? 'install'
		: has('--restart')
			? 'restart'
			: has('--reassert')
				? 'reassert'
				: has('--end')
					? 'end'
					: has('--keep')
						? 'keep'
						: has('--remove')
							? 'remove'
							: has('--ci-shaped')
								? 'ci-shaped'
								: 'declare';

/** Human lines go to stderr under --json, so stdout is the one document. */
const say = (line) => (JSON_OUT ? console.error(line) : console.log(line));

function finish(ok, fields) {
	if (JSON_OUT) console.log(JSON.stringify({ ok, action, node: node ?? null, ...fields }, null, 2));
	else if (!ok) console.error(`hosting: ${fields.reason}`);
	process.exit(ok ? 0 : 1);
}
const refuse = (reason, extra = {}) => finish(false, { state: 'refused', reason, ...extra });

let manifest;
let drainDoc;
let hostingDoc;
let registry;
try {
	manifest = loadManifest();
	drainDoc = readDrainDoc();
	hostingDoc = readHostingDoc(stateDir());
	registry = readTenantRegistry(stateDir());
} catch (err) {
	refuse(`cannot read fleet state: ${err.message}`);
}
const by = process.env.SUDO_USER || process.env.USER || 'unknown';

/** The controller's reserved LAN address — the only source the port is opened to. */
function controllerIp() {
	const ip = manifest.machines?.[CONTROLLER_NODE]?.lan?.ip;
	if (!ip) {
		refuse(
			`machines.${CONTROLLER_NODE}.lan.ip is not recorded, so there is no address to open the ` +
				'port to. Record the reservation first (`fleet preflight` names it).'
		);
	}
	return ip;
}

/**
 * The controller's addresses: its reserved LAN address from the manifest, and
 * its tailnet addresses as tailscale reports them on the controller itself.
 * The tailnet ones are opened above the mesh allow, so they must be read.
 */
async function controllerAddrs() {
	const lan = controllerIp();
	const r = await runOn(CONTROLLER_NODE, 'tailscale ip -4; tailscale ip -6', {
		as: 'admin',
		timeoutMs: 15_000,
	});
	const ips = r.stdout.split('\n').map((l) => l.trim());
	const tailnet4 = ips.find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) ?? null;
	const tailnet6 = ips.find((l) => l.includes(':')) ?? null;
	if (!tailnet4) {
		refuse(
			`could not read ${CONTROLLER_NODE}'s tailnet address (${r.error ?? r.stderr.trim() ?? 'no answer'}), ` +
				'so the tailnet rule would shut the controller out with everyone else.'
		);
	}
	return { lan, tailnet4, tailnet6 };
}

/** A registered tenant's spec (lib/tenant-registry.mjs), or null. */
const specOf = (tenant) => (tenant ? tenantSpec(registry, tenant) : null);

async function observe(name, spec) {
	const r = await runOn(
		name,
		observeScript(spec ?? NO_TENANT, nodeUser(manifest.machines?.[name], 'ci')),
		{
			as: 'admin',
			timeoutMs: 30_000,
			connectTimeout: 6,
		}
	);
	return { obs: parseObserved(r.stdout), error: r.ok ? null : (r.error ?? r.stderr.trim()) };
}

/** Every node with a hosting record, either kind, lapsed or not — a lapsed one is still checked. */
function hostingNodes() {
	const out = [];
	for (const [name, rec] of Object.entries(drainDoc.nodes)) {
		if (rec.kind === 'hosting' && rec.hosting)
			out.push({ name, mode: 'whole', declared: rec.hosting, until: rec.until ?? null });
	}
	for (const [name, rec] of Object.entries(hostingDoc.nodes)) {
		const { tenant, memoryMb, cores, port } = rec;
		out.push({
			name,
			mode: 'shared',
			declared: { tenant, memoryMb, cores, port },
			until: rec.until ?? null,
		});
	}
	return out;
}

/** What `--check` and a declaration both report: declared vs observed, judged. */
async function checkOne({ name, mode, declared, until }) {
	const spec = specOf(declared.tenant);
	const { obs, error } = await observe(name, spec);
	// Reach is a `controller` ingress's question; a loopback tenant is judged from its socket.
	const reach =
		obs && spec?.ingress === 'controller'
			? await probeReach({
					port: declared.port,
					addrs: {
						lan: manifest.machines?.[name]?.lan?.ip ?? null,
						tailnet4: obs.tailnet4,
						tailnet6: obs.tailnet6,
					},
					peers: peerCandidates(manifest, name),
					run: runOn,
				})
			: null;
	const judged = judgeHosting(declared, obs, mode, reach, spec);
	if (!obs && error) judged.findings[0].why += ` (${error})`;
	const blocking = judged.findings.some((f) => f.class === 'blocking');
	return {
		node: name,
		mode,
		declared,
		until,
		state: blocking ? 'not-guaranteed' : 'guaranteed',
		...judged,
	};
}

if (action === 'check') {
	const rows = [];
	for (const h of hostingNodes()) rows.push(await checkOne(h));
	for (const r of rows) {
		say(`── ${r.node}  ${r.mode}  ${r.declared?.tenant ?? '?'}  ${r.state}`);
		for (const f of r.findings) say(`   ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
	}
	if (!rows.length) say('no node is hosting.');
	const ok = rows.every((r) => r.state === 'guaranteed');
	if (JSON_OUT) console.log(JSON.stringify({ ok, hosting: rows.length, nodes: rows }, null, 2));
	process.exit(ok ? 0 : 1);
}

if (!node) refuse('name a node, or use --check. See --help.');
const machine = manifest.machines?.[node];
if (!machine) refuse(`${node} is not a declared node.`);
if (isGuestNode(machine))
	refuse(
		`${node} is a guest. A guest lends the fleet a registration and nothing else; it is not lent onward.`
	);
const current = hostingOn(node, drainDoc, hostingDoc, NOW);
const wholeRec = drainDoc.nodes[node]?.kind === 'hosting' ? drainDoc.nodes[node] : null;
const sharedRec = hostingDoc.nodes[node] ?? null;
const recordTenant = wholeRec?.hosting?.tenant ?? sharedRec?.tenant ?? null;

if (action === 'install') {
	const tenant = recordTenant ?? valueOf('--tenant');
	const spec = specOf(tenant);
	if (!spec) refuse(`${node} is not hosting, so there is nothing to install into.`);
	if (!spec.exec)
		refuse(
			`${tenant} is a ${spec.kind}: its app layer deploys it, so the fleet installs no executable.`
		);
	const path = valueOf('--install');
	const want = String(valueOf('--sha256') ?? '').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(want)) refuse('--install needs --sha256 <64 hex digits>.');
	let bytes;
	try {
		if (statSync(path).size > INSTALL_MAX_BYTES)
			refuse(
				`${path} is larger than ${INSTALL_MAX_BYTES} bytes; install a launcher, not the payload.`
			);
		bytes = readFileSync(path);
	} catch (err) {
		refuse(`cannot read ${path}: ${err.message}`);
	}
	const local = createHash('sha256').update(bytes).digest('hex');
	if (local !== want) refuse(`${path} hashes to ${local} here, not ${want}; nothing was sent.`);
	const r = await runOn(node, installScript(spec, bytes.toString('base64'), want), {
		as: 'admin',
		timeoutMs: 120_000,
	});
	if (!r.stdout.includes('INSTALL-OK')) {
		const line = r.stdout.split('\n').find((l) => l.startsWith('INSTALL-FAIL'));
		refuse(line ?? `install on ${node} did not finish: ${r.error ?? r.stderr.trim()}`);
	}
	say(`✓ ${spec.exec} on ${node} is ${want}, root-owned; the agent restarted.`);
	// KEPT for the converger, so a slice it declares later gets these bytes too
	// (lib/hosting-artifacts.mjs). The install already happened, so failing to
	// keep it is said, never turned into a failed install.
	let kept;
	try {
		kept = {
			ok: true,
			...keepArtifact(stateDir(), tenant, bytes, { by, nowIso: new Date(NOW).toISOString() }),
		};
	} catch (err) {
		kept = { ok: false, why: err.message };
		say(`  could not keep it for slices the fleet declares: ${err.message}`);
	}
	finish(true, { state: 'installed', sha256: want, exec: spec.exec, kept });
}

if (action === 'restart') {
	const spec = specOf(recordTenant);
	if (!spec) refuse(`${node} is not hosting.`);
	const r = await runOn(node, restartScript(spec), { as: 'admin', timeoutMs: 60_000 });
	const m = /RESTARTED (\d+)/.exec(r.stdout);
	if (!m) refuse(`restart on ${node} did not finish: ${r.error ?? r.stderr.trim()}`);
	say(`✓ ${spec.service} on ${node} restarted (pid ${m[1]}).`);
	finish(true, { state: 'restarted', pid: Number(m[1]) || null });
}

// THE NODE SIDE, AGAIN, FROM THE RECORD. A re-declare would do it too, but it
// rewrites the record — reason, and a scheduled end taken back — so nothing
// unattended may use it. The node-users cutover calls this: a new ci user has
// its own user manager, and the slice's CI headroom and OOM ranking lived in
// the old one (claw-8 and claw-6 read not-guaranteed on 2026-10-31).
if (action === 'reassert') {
	if (!current) refuse(`${node} holds no live hosting record, so there is nothing to re-assert.`);
	const spec = specOf(current.tenant);
	if (!spec) refuse(`${current.tenant} is not a registered tenant.`);
	const { mode, until, ...declared } = current;
	const shared = mode === 'shared';
	const r = await runOn(
		node,
		deployScript(
			spec,
			{ memoryMb: current.memoryMb, cores: current.cores },
			await controllerAddrs(),
			{ shared, ciUser: nodeUser(machine, 'ci') }
		),
		{ as: 'admin', timeoutMs: 120_000 }
	);
	if (!r.stdout.includes('HOSTING-DEPLOYED'))
		refuse(`re-assert on ${node} did not finish: ${r.error ?? r.stderr.trim()}`);
	const row = await checkOne({ name: node, mode, declared, until: until ?? null });
	for (const f of row.findings) say(`  ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
	say(
		`${row.state === 'guaranteed' ? '✓' : '✗'} ${node}: ${current.tenant}'s slice re-asserted, ${row.state}.`
	);
	finish(row.state === 'guaranteed', {
		state: row.state,
		mode,
		findings: row.findings,
		...(row.state === 'guaranteed'
			? {}
			: { reason: `${node} is ${row.state} after the re-assert` }),
	});
}

if (action === 'ci-shaped') {
	if (!tail.length) refuse('--ci-shaped needs a command after --.');
	const { obs, error } = await observe(node, recordTenant ?? 'cardtable');
	if (!obs?.memTotalMb) refuse(`could not read ${node}'s memory: ${error ?? 'no answer'}`);
	const memoryMaxMb = obs.memTotalMb - (machine.minFreeMb ?? 1536);
	const r = await runOn(
		node,
		ciShapedScript(tail.join(' '), { memoryMaxMb, wait: has('--wait') }),
		{ as: 'ci', timeoutMs: has('--wait') ? 6 * 3_600_000 : 60_000 }
	);
	const m = /CI-SHAPED (\S+)/.exec(r.stdout);
	if (!m) refuse(`could not start a CI-shaped unit on ${node}: ${r.error ?? r.stderr.trim()}`);
	if (!JSON_OUT) process.stdout.write(r.stdout.replace(/^CI-SHAPED .*\n?/m, ''));
	finish(true, {
		state: has('--wait') ? 'finished' : 'started',
		unit: m[1],
		memoryMaxMb,
		output: JSON_OUT ? r.stdout : undefined,
	});
}

if (action === 'end') {
	if (!current) refuse(`${node} is not hosting.`);
	const spec = valueOf('--at') ?? valueOf('--in');
	if (!spec) refuse('--end needs --in <duration> or --at <iso>.');
	let endMs;
	try {
		endMs = parseWhen(spec, NOW);
	} catch (err) {
		refuse(err.message);
	}
	const refusal = noticeRefusal(node, endMs, drainDoc, NOW, { hostingDoc, kind: 'end' });
	if (refusal && !has('--force'))
		refuse(`${refusal} Use --in 15m or later, or --force if the box is failing.`);
	const until = new Date(endMs).toISOString();
	if (current.mode === 'whole') {
		writeDrainDoc(
			{
				nodes: { ...drainDoc.nodes, [node]: { ...wholeRec, until } },
				planned: drainDoc.planned,
			},
			drainDoc
		);
	} else {
		writeHostingDoc(
			{ nodes: { ...hostingDoc.nodes, [node]: { ...sharedRec, until } } },
			stateDir()
		);
	}
	say(`✓ ${node} stops hosting at ${until}. Then: fleet hosting ${node} --remove`);
	finish(true, { state: 'ending', until, mode: current.mode });
}

if (action === 'keep') {
	const rec = wholeRec ?? sharedRec;
	if (!rec) refuse(`${node} is not hosting.`);
	if (!rec.until) refuse(`${node} has no end scheduled.`);
	const { until: was, ...kept } = rec;
	if (wholeRec)
		writeDrainDoc(
			{ nodes: { ...drainDoc.nodes, [node]: kept }, planned: drainDoc.planned },
			drainDoc
		);
	else writeHostingDoc({ nodes: { ...hostingDoc.nodes, [node]: kept } }, stateDir());
	say(`✓ ${node} keeps hosting; the end at ${was} is taken back.`);
	finish(true, { state: 'kept', was, mode: wholeRec ? 'whole' : 'shared' });
}

if (action === 'remove') {
	const rec = wholeRec ?? sharedRec;
	if (!rec && drainDoc.nodes[node])
		refuse(`${node} is drained as '${drainDoc.nodes[node].kind}', not hosting.`);
	const endMs = Date.parse(rec?.until ?? '');
	if (rec && !(endMs <= NOW) && !has('--force')) {
		refuse(
			rec.until
				? `${node} hosts until ${rec.until}. Remove it after that, or --force.`
				: `${node} has no end scheduled. Run --end --in 30m first, so the tenant sees it coming.`
		);
	}
	const tenant = recordTenant ?? valueOf('--tenant');
	const spec = specOf(tenant);
	if (!spec)
		refuse(
			`which tenant? Pass --tenant with a registered one (${Object.keys(registry.tenants).join(', ') || 'none registered'}).`
		);
	const r = await runOn(
		node,
		removeScript(spec, controllerIp(), { ciUser: nodeUser(machine, 'ci') }),
		{
			as: 'admin',
			timeoutMs: 60_000,
		}
	);
	if (!r.stdout.includes('HOSTING-REMOVED')) {
		refuse(
			`teardown on ${node} did not finish: ${r.error ?? r.stderr.trim()}. The record is kept.`
		);
	}
	// Read back what survived, from the node (cardtable A11). The record stays
	// until nothing does: a removed slice whose firewall rule or cgroup lingers
	// is not removed.
	const back = await runOn(node, leftoversScript(spec, { ciUser: nodeUser(machine, 'ci') }), {
		as: 'admin',
		timeoutMs: 30_000,
		connectTimeout: 6,
	});
	const leftovers = parseLeftovers(back.stdout);
	if (!leftovers.complete || leftovers.left.length) {
		finish(false, {
			state: 'remove-incomplete',
			reason: leftovers.complete
				? `teardown left: ${leftovers.left.join('; ')}. The record is kept; re-run --remove.`
				: `could not read back ${node} after the teardown (${back.error ?? 'no answer'}). The record is kept.`,
			left: leftovers.left,
		});
	}
	if (wholeRec) {
		const nodes = { ...drainDoc.nodes };
		delete nodes[node];
		writeDrainDoc({ nodes, planned: drainDoc.planned }, drainDoc);
	}
	if (sharedRec) {
		const nodes = { ...hostingDoc.nodes };
		delete nodes[node];
		writeHostingDoc({ nodes }, stateDir());
	}
	say(`✓ ${node} is no longer hosting; units, executable and port ${spec.port} removed.`);
	finish(true, { state: 'removed', left: [] });
}

// ── declare ──────────────────────────────────────────────────────────────────
const shared = has('--shared');
const tenant = valueOf('--tenant');
// A hot standby: waits on the tenant's lease, never a second writer, never toward slices.max.
const role = valueOf('--role');
if (role !== null && role !== 'standby') refuse(`--role takes one value, standby; got ${role}.`);
const spec = specOf(tenant);
if (!spec)
	refuse(
		`${tenant ?? '(none)'} is not a registered tenant. Register its hosting.json first: fleet hosting-request <owner/repo> --register.`
	);
let resources;
try {
	resources = {
		memoryMb: parseMemoryMb(valueOf('--memory')),
		cores: parseCores(valueOf('--cores')),
	};
} catch (err) {
	refuse(err.message);
}
if (current && current.mode !== (shared ? 'shared' : 'whole'))
	refuse(`${node} is already hosting as ${current.mode}. End and remove that first.`);
// Promoting a standby is the lease's job, not the record's: never flip a role in place.
if (current && (current.role ?? null) !== role)
	refuse(
		`${node} already hosts ${current.tenant} as ${current.role ?? 'primary'}. End and remove that first.`
	);
const drained = drainDoc.nodes[node];
if (!shared && drained && !['hosting', 'lease'].includes(drained.kind) && !has('--force')) {
	refuse(
		`${node} is drained as '${drained.kind ?? 'maintenance'}' (${drained.reason}). ` +
			'Somebody took it out for a reason; --force if hosting should replace that.'
	);
}
const controller = await controllerAddrs();

// The node's own measurement, never the manifest's rounded ramGb.
const before = await observe(node, spec);
if (!before.obs) refuse(`could not observe ${node}: ${before.error ?? 'no answer'}`);
const misfit = fitProblems(resources, before.obs, machine.minFreeMb ?? 1024);
if (misfit.length) refuse(`the declaration does not fit ${node}: ${misfit.join('; ')}`);

// THE TENANT'S OWN RULES, at the moment a slice is promised. The same plan
// `fleet hosting-plan` makes (placement.require, the fit, ciMayRead's policy),
// so a declare cannot put a tenant where its plan refuses it: archivebot on a
// Wi-Fi claw whose CI is root went through with nothing in the way until
// 2026-10-27. A re-declare of the slice this node already holds was judged
// when it was made, and is not judged again. --force overrides, and says so.
let placement = null;
if (shared && !sharedRec) {
	const request = registry.tenants[tenant].request;
	const { offers } = await collectOffers(manifest, { tools: request.runtime?.tools ?? [] });
	const plan = planFor(request, offers);
	// A drain is about CI, not about where a tenant may live: a slice is often
	// declared under the tenant's own lease drain.
	const found = plan.refused.find((r) => r.node === node);
	const reasons = (found?.reasons ?? []).filter((r) => !/^drained /.test(r));
	const refused = reasons.length ? { ...found, reasons } : null;
	const ranked = plan.ranked.find((r) => r.node === node);
	placement = { policy: plan.ciMayReadPolicy, ...(ranked?.risk ? { risk: ranked.risk } : {}) };
	if (role === 'standby') {
		const wanted = request.availability.standby ?? 0;
		if (!wanted) refuse(`${tenant}'s hosting.json asks for no standby (availability.standby).`);
		if (plan.standby.held.length >= wanted)
			refuse(
				`${tenant} already holds ${plan.standby.held.length} of its ${wanted} standby slice(s).`
			);
	} else if (plan.atMax)
		refuse(`${tenant} already holds ${plan.held.length} of its ${request.slices.max} slices.`);
	if (refused && !has('--force'))
		refuse(
			`${tenant}'s own placement refuses ${node}: ${refused.reasons.join('; ')}. --force overrides.`,
			{
				placement: { ...placement, reasons: refused.reasons },
			}
		);
	if (refused) say(`  FORCED past ${tenant}'s placement: ${refused.reasons.join('; ')}`);
	if (ranked?.risk) say(`  risk: ${ranked.risk}`);
}

const base = {
	since: current ? (wholeRec?.since ?? sharedRec?.since) : new Date(NOW).toISOString(),
	reason: valueOf('--reason') ?? `${tenant} hosting node`,
	by,
};
const declared = { tenant, ...resources, port: spec.port, ...(role ? { role } : {}) };
// A resize restarts the hold-back's grace: the new size is not in use yet.
if (current && (current.memoryMb !== declared.memoryMb || current.cores !== declared.cores))
	base.since = new Date(NOW).toISOString();
if (shared) {
	writeHostingDoc({ nodes: { ...hostingDoc.nodes, [node]: { ...base, ...declared } } }, stateDir());
	say(
		`✓ ${node} hosts ${tenant} beside CI; the dispatcher holds the slice back from its next pass.`
	);
} else {
	writeDrainDoc(
		{
			nodes: { ...drainDoc.nodes, [node]: { ...base, kind: 'hosting', hosting: declared } },
			planned: drainDoc.planned,
		},
		drainDoc
	);
	say(`✓ ${node} is a ${tenant} hosting node; CI is held off from the next fast-loop tick.`);
}
// The dispatcher re-reads the record every pass (15 s).
const admissionFrom = new Date(NOW + 15_000).toISOString();

const r = await runOn(
	node,
	deployScript(spec, resources, controller, { shared, ciUser: nodeUser(machine, 'ci') }),
	{
		as: 'admin',
		timeoutMs: 120_000,
	}
);
if (!r.stdout.includes('HOSTING-DEPLOYED')) {
	finish(false, {
		state: 'not-guaranteed',
		reason: `deploy on ${node} did not finish: ${r.error ?? r.stderr.trim()}. The record stands; re-run to finish.`,
		admissionFrom,
	});
}
const row = await checkOne({
	name: node,
	mode: shared ? 'shared' : 'whole',
	declared,
	until: null,
});
say(
	`  served:  ${row.observed?.memoryMb ?? '?'} MiB (min ${row.observed?.memoryMinMb ?? '?'}), ${row.observed?.cores ?? '?'} cores`
);
say(
	`  agent:   ${row.observed?.agent ?? '?'} as ${spec.user} (port ${spec.port}, ${spec.exec ?? `${spec.kind}, deployed by its app layer`})`
);
for (const f of row.findings) say(`  ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
if (!shared && row.state !== 'guaranteed')
	say(
		'  Running CI jobs finish first (a drain never kills one); check again with `fleet hosting --check`.'
	);
// Accepted with blocking findings is still accepted: the record stands and
// --check names what is missing. `ok` says whether the guarantee holds NOW.
finish(row.state === 'guaranteed', {
	state: row.state,
	reason:
		row.state === 'guaranteed'
			? null
			: row.findings
					.filter((f) => f.class === 'blocking')
					.map((f) => f.why)
					.join('; '),
	mode: row.mode,
	declared,
	admissionFrom,
	observed: row.observed,
	findings: row.findings,
	placement,
});
