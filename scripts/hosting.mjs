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
 *             agent can start. A node may hold several shared slices, one per
 *             tenant (fleet-manager#32); every action on such a node names the
 *             one it means with `--tenant`.
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
 *   fleet hosting claw-4 --tenant archivebot --reassert   # a node with several tenants
 *   fleet hosting claw-9 --ci-shaped [--wait] -- <command>
 *   fleet hosting --check
 *   (every action takes --json)
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

import { HOSTING_NOTICE_MS, noticeRefusal, parseWhen } from '../dist/runners/drain.js';
import {
	hostingsOn,
	issueEpoch,
	readHostingDoc,
	withEnded,
	withMoveClosed,
	withMoveOpen,
	withSlice,
	withoutSlice,
	writeHostingDoc,
} from '../dist/runners/hosting-record.js';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { readTenantRegistry, tenantSpec, withSteadyMb } from './lib/tenant-registry.mjs';
import { isBackstopNode } from '../dist/lib/node-role.js';
import { nodeUser } from '../dist/lib/node-users.js';
import { readDrainDoc, writeDrainDoc } from './lib/expected-down.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { collectOffers } from './lib/collect-offers.mjs';
import { checkSlice, hostingRecords, observeNode, slicesMb } from './lib/hosting-check.mjs';
import { keepArtifact } from './lib/hosting-artifacts.mjs';
import { planFor } from './lib/hosting-plan.mjs';
import { shrinkOf, unitsRefusal } from './lib/hosting-units.mjs';
import {
	controllerAddrs as controllerAddrsOf,
	controllerIp as controllerIpOf,
} from './lib/hosting-controller.mjs';
import {
	INSTALL_MAX_BYTES,
	ciShapedScript,
	deployScript,
	fitProblems,
	installScript,
	leftoversScript,
	parseCores,
	parseMemoryMb,
	parseLeftovers,
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
	'--move',
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
			'fleet hosting <node> --tenant <name> --memory 1536M --cores 2 --shared --move',
			"        open a singleton's move to <node>: a new epoch, the old slice still serving. Ending or",
			'        removing the old slice commits it; ending or removing this one aborts it.',
			'fleet hosting <node> --install <path> --sha256 <hex>',
			"        put the tenant's executable in place, root-owned, and restart the agent.",
			'fleet hosting <node> --restart',
			'        restart the agent (after it upgraded itself).',
			'fleet hosting <node> [--tenant <name>] --reassert',
			'        re-run the node side of the slice it holds, from its record; the record is not touched.',
			'fleet hosting <node> --end (--in 30m | --at <iso>) [--force]',
			`        schedule the end; the tenant is owed ${HOSTING_NOTICE_MS / 60_000} min notice.`,
			'        with --memory/--cores: a SHRINK to that size, re-declared by the converger at the end.',
			'fleet hosting <node> --keep',
			'        take a scheduled end back, while the units are still there.',
			'fleet hosting <node> --remove [--force]',
			'        take the units, executable and port away once the end has passed.',
			'fleet hosting <node> --ci-shaped [--wait] -- <command>',
			'        run <command> contained exactly as a CI job is, with no GitHub job (tests).',
			'fleet hosting --check',
			'        declared vs observed, from the kernel, for every hosting node.',
			'On a node with several shared tenants, every action names one with --tenant.',
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

/** The controller's addresses (lib/hosting-controller.mjs), or the door refuses with why not. */
const controllerIp = () => controllerIpOf(manifest).ip ?? refuse(controllerIpOf(manifest).why);
const controllerAddrs = async () => {
	const { addrs, why } = await controllerAddrsOf(manifest);
	return addrs ?? refuse(why);
};

/** A registered tenant's spec (lib/tenant-registry.mjs), or null. */
const specOf = (tenant) => (tenant ? tenantSpec(registry, tenant) : null);

/** `tenant`'s primary records in force, either mode, on every node: `[{ node, ...HostingOn }]`. */
const primariesOf = (tenant) =>
	[...new Set([...Object.keys(drainDoc.nodes), ...Object.keys(hostingDoc.nodes)])].flatMap((n) =>
		hostingsOn(n, drainDoc, hostingDoc, NOW)
			.filter((h) => h.tenant === tenant && h.role !== 'standby')
			.map((h) => ({ node: n, ...h }))
	);

/**
 * `doc` with a singleton's open move closed, when this action's slice is one
 * end of it: ending or removing the node it leaves COMMITS the move (the
 * mover has stopped it there and the new node serves), ending or removing
 * the node it goes to ABORTS it. Any other slice, or a SHRINK, leaves the move alone.
 */
function closingMove(doc, tenant, shrink = null) {
	const move = doc.apps?.[tenant]?.move;
	if (shrink || !move || (move.from !== node && move.to !== node)) return { doc, closed: null };
	const outcome = move.from === node ? 'committed' : 'aborted';
	return {
		doc: withMoveClosed(doc, tenant, outcome, new Date(NOW).toISOString()),
		closed: { ...move, outcome },
	};
}

/** The context every slice check runs in (lib/hosting-check.mjs). */
const checkCtx = () => ({ manifest, hostingDoc, specOf, run: runOn });

const observe = (name, spec) => observeNode(checkCtx(), name, spec);

/** What `--check` and a declaration both report: declared vs observed, judged. */
const checkOne = async (h) => (await checkSlice(checkCtx(), h)).row;

if (action === 'check') {
	const rows = [];
	for (const h of hostingRecords(drainDoc, hostingDoc)) rows.push(await checkOne(h));
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
if (isBackstopNode(machine))
	refuse(
		`${node} is the backstop: not capacity, and the production host. It is not lent to a hosting tenant.`
	);
const wholeRec = drainDoc.nodes[node]?.kind === 'hosting' ? drainDoc.nodes[node] : null;
const sharedRecs = hostingDoc.nodes[node] ?? [];
const tenantArg = valueOf('--tenant');
/**
 * The shared record an action on this node means: the one `--tenant` names,
 * or the only one. Several and no `--tenant` is refused rather than guessed,
 * because a guess ends or removes the wrong tenant. A declaration is always
 * about its own `--tenant`.
 */
const sharedRec = (() => {
	if (tenantArg !== null) return sharedRecs.find((r) => r.tenant === tenantArg) ?? null;
	// --ci-shaped reads only the node's memory, whichever tenant answers.
	if (sharedRecs.length <= 1 || action === 'ci-shaped') return sharedRecs[0] ?? null;
	return refuse(
		`${node} holds ${sharedRecs.length} shared tenants (${sharedRecs.map((r) => r.tenant).join(', ')}); name one with --tenant.`
	);
})();
const recordTenant = wholeRec?.hosting?.tenant ?? sharedRec?.tenant ?? null;
/** The live hosting the action means, whole or this tenant's shared slice; null past its end. */
const current =
	hostingsOn(node, drainDoc, hostingDoc, NOW).find(
		(h) => h.mode === 'whole' || h.tenant === recordTenant
	) ?? null;
/** Every OTHER tenant's slice on this node, summed. */
const othersMb = slicesMb(hostingDoc, node) - (sharedRec?.memoryMb ?? 0);

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
/**
 * Run `hosting`'s node side again and judge it: `{ row }`, or `{ why }` when
 * the deploy did not finish. `nodeMb` is the node's shared slices summed.
 */
async function reassertOne(hosting, nodeMb) {
	const spec = specOf(hosting.tenant);
	if (!spec) return { why: `${hosting.tenant} is not a registered tenant.` };
	const { mode, until, tenant, memoryMb, cores, port, role } = hosting;
	const declared = { tenant, memoryMb, cores, port, ...(role ? { role } : {}) };
	const shared = mode === 'shared';
	const r = await runOn(
		node,
		deployScript(
			spec,
			{ memoryMb: hosting.memoryMb, cores: hosting.cores },
			await controllerAddrs(),
			{ shared, ciUser: nodeUser(machine, 'ci'), ...(shared ? { nodeMb } : {}) }
		),
		{ as: 'admin', timeoutMs: 120_000 }
	);
	if (!r.stdout.includes('HOSTING-DEPLOYED'))
		return {
			why: `re-assert of ${hosting.tenant} on ${node} did not finish: ${r.error ?? r.stderr.trim()}`,
		};
	const row = await checkOne({ name: node, mode, declared, until: until ?? null });
	for (const f of row.findings) say(`  ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
	say(
		`${row.state === 'guaranteed' ? '✓' : '✗'} ${node}: ${hosting.tenant}'s slice re-asserted, ${row.state}.`
	);
	return { row };
}

if (action === 'reassert') {
	if (!current) refuse(`${node} holds no live hosting record, so there is nothing to re-assert.`);
	const { row, why } = await reassertOne(current, slicesMb(hostingDoc, node));
	if (why) refuse(why);
	finish(row.state === 'guaranteed', {
		state: row.state,
		mode: row.mode,
		tenant: current.tenant,
		findings: row.findings,
		...(row.state === 'guaranteed'
			? {}
			: { reason: `${node} is ${row.state} after the re-assert` }),
	});
}

if (action === 'ci-shaped') {
	if (!tail.length) refuse('--ci-shaped needs a command after --.');
	const { obs, error } = await observe(node, specOf(recordTenant));
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
	// Only the tenant whose slice ends is owed this notice, not its neighbours.
	const refusal = noticeRefusal(node, endMs, drainDoc, NOW, {
		hostingDoc: { nodes: current.mode === 'shared' ? { [node]: [sharedRec] } : {} },
		kind: 'end',
	});
	if (refusal && !has('--force'))
		refuse(`${refusal} Use --in 15m or later, or --force if the box is failing.`);
	const until = new Date(endMs).toISOString();
	// With a size, the end is a SHRINK (lib/hosting-units.mjs): it keeps serving, then is re-declared smaller.
	const shrink = shrinkOf(
		valueOf('--memory'),
		valueOf('--cores'),
		current.mode === 'shared' && sharedRec
	);
	if (shrink.why) refuse(shrink.why);
	const { shrinkTo } = shrink;
	const { doc: closedDoc, closed } = closingMove(hostingDoc, current.tenant, shrinkTo);
	if (current.mode === 'whole') {
		writeDrainDoc(
			{
				nodes: { ...drainDoc.nodes, [node]: { ...wholeRec, until } },
				planned: drainDoc.planned,
			},
			drainDoc
		);
		if (closed) writeHostingDoc(closedDoc, stateDir());
	} else {
		writeHostingDoc(
			withSlice(closedDoc, node, { ...sharedRec, until, ...(shrinkTo ? { shrinkTo } : {}) }),
			stateDir()
		);
	}
	const named = sharedRecs.length > 1 ? ` --tenant ${current.tenant}` : '';
	say(
		shrinkTo
			? `✓ ${node} shrinks ${current.tenant} to ${shrinkTo.memoryMb} MiB at ${until}; the converger re-declares it then.`
			: `✓ ${node} stops hosting ${current.tenant} at ${until}. Then: fleet hosting ${node}${named} --remove`
	);
	if (closed)
		say(`  the move ${closed.from} → ${closed.to} (epoch ${closed.epoch}) is ${closed.outcome}.`);
	finish(true, {
		state: shrinkTo ? 'shrinking' : 'ending',
		until,
		...(shrinkTo ? { shrinkTo } : {}),
		mode: current.mode,
		tenant: current.tenant,
		...(closed ? { move: closed } : {}),
	});
}

if (action === 'keep') {
	const rec = wholeRec ?? sharedRec;
	if (!rec) refuse(`${node} is not hosting.`);
	if (!rec.until) refuse(`${node} has no end scheduled.`);
	// A singleton whose move committed serves from its new node; taking the old
	// slice's end back would make two places that may run it.
	const keptTenant = wholeRec?.hosting?.tenant ?? sharedRec.tenant;
	if (registry.tenants[keptTenant]?.request.availability?.singleton) {
		const other = primariesOf(keptTenant).find((h) => h.node !== node);
		if (other)
			refuse(
				`${keptTenant} is a singleton and ${other.node} holds it; keeping ${node} would be a second writer.`
			);
	}
	const { until: was, shrinkTo: _, ...kept } = rec;
	if (wholeRec)
		writeDrainDoc(
			{ nodes: { ...drainDoc.nodes, [node]: kept }, planned: drainDoc.planned },
			drainDoc
		);
	else writeHostingDoc(withSlice(hostingDoc, node, kept), stateDir());
	say(`✓ ${node} keeps hosting ${recordTenant}; the end at ${was} is taken back.`);
	finish(true, { state: 'kept', was, mode: wholeRec ? 'whole' : 'shared', tenant: recordTenant });
}

if (action === 'remove') {
	const rec = wholeRec ?? sharedRec;
	if (!rec && drainDoc.nodes[node])
		refuse(`${node} is drained as '${drainDoc.nodes[node].kind}', not hosting.`);
	const endMs = Date.parse(rec?.until ?? '');
	if (rec && (rec.shrinkTo || !(endMs <= NOW)) && !has('--force')) {
		refuse(
			rec.shrinkTo
				? `${node} shrinks to ${rec.shrinkTo.memoryMb} MiB at ${rec.until}; the converger re-declares it. --force removes it all.`
				: rec.until
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
		removeScript(spec, controllerIp(), { ciUser: nodeUser(machine, 'ci'), othersMb }),
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
	const back = await runOn(
		node,
		leftoversScript(spec, { ciUser: nodeUser(machine, 'ci'), othersMb }),
		{
			as: 'admin',
			timeoutMs: 30_000,
			connectTimeout: 6,
		}
	);
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
	// What was here stays readable for a day, so a tenant can tell "ended" from "vanished".
	const gone = wholeRec ? { ...wholeRec.hosting, until: wholeRec.until } : (sharedRec ?? null);
	const { doc: closedDoc, closed } = closingMove(hostingDoc, tenant);
	hostingDoc = closedDoc;
	if (sharedRec) hostingDoc = withoutSlice(hostingDoc, node, sharedRec.tenant);
	if (gone)
		hostingDoc = withEnded(
			hostingDoc,
			tenant,
			{
				node,
				...(gone.until ? { until: gone.until } : {}),
				removedAt: new Date(NOW).toISOString(),
				...(gone.role ? { role: gone.role } : {}),
				...(gone.epoch !== undefined ? { epoch: gone.epoch } : {}),
			},
			NOW
		);
	if (sharedRec || gone || closed) writeHostingDoc(hostingDoc, stateDir());
	say(`✓ ${node} no longer hosts ${tenant}; units, executable and port ${spec.port} removed.`);
	if (closed)
		say(`  the move ${closed.from} → ${closed.to} (epoch ${closed.epoch}) is ${closed.outcome}.`);
	// The tenants that stay held the parent slice and CI's headroom at the old
	// sum. Their node side runs again at the new one.
	const stay = hostingsOn(node, drainDoc, hostingDoc, NOW);
	const failed = [];
	for (const h of stay) {
		const { row, why } = await reassertOne(h, othersMb);
		if (why || row.state !== 'guaranteed')
			failed.push(why ?? `${h.tenant} is ${row.state} after the re-assert`);
	}
	if (failed.length)
		finish(false, {
			state: 'removed',
			tenant,
			left: [],
			reason: `removed, but the tenants that stay are not guaranteed: ${failed.join('; ')}`,
			...(closed ? { move: closed } : {}),
		});
	finish(true, { state: 'removed', tenant, left: [], ...(closed ? { move: closed } : {}) });
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
// Whole-box hosting is alone on its node; shared slices sit beside each other.
if (wholeRec && shared)
	refuse(
		`${node} is already hosting ${wholeRec.hosting?.tenant} as whole. End and remove that first.`
	);
if (!shared && sharedRecs.length)
	refuse(
		`${node} already hosts ${sharedRecs.map((r) => r.tenant).join(', ')} as shared. End and remove that first.`
	);
// Promoting a standby is the lease's job, not the record's: never flip a role in place.
if (current && (current.role ?? null) !== role)
	refuse(
		`${node} already hosts ${current.tenant} as ${current.role ?? 'primary'}. End and remove that first.`
	);

// A SINGLETON IS NEVER DECLARED TWICE BY ACCIDENT (fleet-manager#16). Its
// second primary is a move, said with --move, and only one is open at a time:
// the new node gets the next epoch, and the old one keeps serving until the
// mover has stopped it and the old slice is ended.
const singleton = registry.tenants[tenant].request.availability?.singleton === true;
const elsewhere = role === 'standby' ? [] : primariesOf(tenant).filter((h) => h.node !== node);
const MOVE = has('--move');
if (MOVE) {
	if (!shared || role)
		refuse("--move opens a move of a singleton's primary slice: it takes --shared and no --role.");
	if (!singleton) refuse(`${tenant} is not a singleton: it takes another slice, not a move.`);
	const open = hostingDoc.apps?.[tenant]?.move;
	if (open)
		refuse(
			`a move of ${tenant} is already open: ${open.from} → ${open.to} (epoch ${open.epoch}). ` +
				`End the slice on ${open.from} to commit it, or on ${open.to} to abort it.`
		);
	if (current) refuse(`${node} already holds ${tenant}; a move goes to another node.`);
	if (elsewhere.length !== 1)
		refuse(
			elsewhere.length
				? `${tenant} holds ${elsewhere.map((h) => h.node).join(', ')}; a move leaves exactly one.`
				: `${tenant} holds no slice to move from; declare it without --move.`
		);
} else if (singleton && elsewhere.length)
	refuse(
		`${tenant} is a singleton and ${elsewhere.map((h) => h.node).join(', ')} holds it. ` +
			'A second place is a move: --move.'
	);
const moveFrom = MOVE ? elsewhere[0].node : null;
// slices.max counts UNITS across the tenant's primaries; a resize is this node's new count.
const tooMany =
	role || MOVE
		? null
		: unitsRefusal(registry.tenants[tenant].request, elsewhere, resources.memoryMb);
if (tooMany) refuse(tooMany);
const drained = drainDoc.nodes[node];
if (!shared && drained && !['hosting', 'lease'].includes(drained.kind) && !has('--force')) {
	refuse(
		`${node} is drained as '${drained.kind ?? 'maintenance'}' (${drained.reason}). ` +
			'Somebody took it out for a reason; --force if hosting should replace that.'
	);
}
const controller = await controllerAddrs();

// The node's own measurement, never the manifest's rounded ramGb, with every
// other tenant's slice already taken out of it.
const before = await observe(node, spec);
if (!before.obs) refuse(`could not observe ${node}: ${before.error ?? 'no answer'}`);
const othersCores = sharedRecs
	.filter((r) => r.tenant !== tenant)
	.reduce((sum, r) => sum + r.cores, 0);
const misfit = fitProblems(
	{ memoryMb: resources.memoryMb + othersMb, cores: resources.cores + othersCores },
	before.obs,
	machine.minFreeMb ?? 1024
);
if (misfit.length) refuse(`the declaration does not fit ${node}: ${misfit.join('; ')}`);

// THE TENANT'S OWN RULES, at the moment a slice is promised. The same plan
// `fleet hosting-plan` makes (placement.require, the fit, ciMayRead's policy),
// so a declare cannot put a tenant where its plan refuses it: archivebot on a
// Wi-Fi claw whose CI is root went through with nothing in the way until
// 2026-10-27. A re-declare of the slice this TENANT already holds here was
// judged when it was made, and is not judged again; another tenant's slice on
// the node is no such thing (pygmalion's declaration skipped this on claw-4
// on 2026-10-29 because archivebot held the node: fleet-manager#32).
// --force overrides, and says so.
let placement = null;
if (shared && !sharedRec) {
	const request = registry.tenants[tenant].request;
	const { offers } = await collectOffers(manifest, { tools: request.runtime?.tools ?? [] });
	// A move is not a second slice: its plan allows one past max, as the converger's does.
	const plan = planFor(
		MOVE ? { ...request, slices: { ...request.slices, max: request.slices.max + 1 } } : request,
		offers
	);
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
	}
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
// THE FENCING TOKEN. A primary on a node that did not hold this tenant gets
// the app's next epoch, recorded before any record carries it. A re-declare
// of the slice already here keeps the one it has: the node did not change.
// (A record from before epochs carries none, and keeps carrying none.)
const heldHere = wholeRec?.hosting?.tenant === tenant ? wholeRec.hosting : sharedRec;
let epoch = null;
if (role !== 'standby') {
	if (heldHere) epoch = heldHere.epoch ?? null;
	else {
		// Every record of this tenant, lapsed ones included, so no token is issued twice.
		const seen = [
			...Object.values(hostingDoc.nodes).flat(),
			...Object.values(drainDoc.nodes)
				.filter((r) => r.kind === 'hosting')
				.map((r) => r.hosting),
		]
			.filter((r) => r?.tenant === tenant && Number.isInteger(r.epoch))
			.map((r) => r.epoch);
		({ doc: hostingDoc, epoch } = issueEpoch(hostingDoc, tenant, seen));
		if (MOVE)
			hostingDoc = withMoveOpen(hostingDoc, tenant, {
				from: moveFrom,
				to: node,
				epoch,
				openedAt: new Date(NOW).toISOString(),
				by,
			});
	}
}
const declared = {
	tenant,
	...withSteadyMb(resources, registry.tenants[tenant].request),
	port: spec.port,
	...(role ? { role } : {}),
	...(epoch !== null ? { epoch } : {}),
};
// A resize restarts the hold-back's grace: the new size is not in use yet.
if (current && (current.memoryMb !== declared.memoryMb || current.cores !== declared.cores))
	base.since = new Date(NOW).toISOString();
if (shared) {
	hostingDoc = withSlice(hostingDoc, node, { ...base, ...declared });
	writeHostingDoc(hostingDoc, stateDir());
	say(
		`✓ ${node} hosts ${tenant} beside CI; the dispatcher holds the slice back from its next pass.`
	);
} else {
	// The token first, so a record never carries one the counter has not issued.
	if (epoch !== null && !heldHere) writeHostingDoc(hostingDoc, stateDir());
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
	deployScript(spec, resources, controller, {
		shared,
		ciUser: nodeUser(machine, 'ci'),
		...(shared ? { nodeMb: slicesMb(hostingDoc, node) } : {}),
	}),
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
	...(MOVE ? { move: { from: moveFrom, to: node, epoch } } : {}),
});
