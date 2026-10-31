#!/usr/bin/env node
/**
 * check-capability-schema — the manifest may only claim capabilities the
 * registry defines, on nodes whose declared specs can carry them.
 *
 * WHY IT IS A SEPARATE GATE FROM `fleet capabilities`
 * ---------------------------------------------------
 * They ask different questions at very different prices, and neither substitutes
 * for the other:
 *
 *   fleet capabilities        "can this node DO what it claims" — SSHes every
 *                             box and EXECUTES the capability. Strong, and it
 *                             cannot run at all without the fleet being up.
 *   fleet capability-schema   "is what the manifest CLAIMS even coherent" —
 *                             pure, offline, complete, and answerable in a
 *                             pull request before anything is deployed.
 *
 * A node `fleet capabilities` could not reach is a node whose promises
 * went unchecked, and it correctly fails on that. This gate has no such hole,
 * which is what makes it the right place for the declaration-time rules.
 *
 * WHAT IT CATCHES THAT NOTHING DID
 * --------------------------------
 *   - a label nothing in the system defines. It routes, it gets projected onto
 *     every runner the node hosts, and no floor watches it.
 *   - a node claiming a capability its manifest entry cannot support — today
 *     that is `jit-canary` without `ephemeral: true`, which would let a STANDING
 *     runner answer the canary and keep it green through a total dispatcher
 *     outage.
 *   - a capability whose consumer reads a field the node did not declare, in
 *     a deployer whose default is PERMISSIVE. `MAX_CONCURRENT=99, MIN_FREE_MB=0`.
 *   - registry/probe drift in both directions.
 *   - a STANDING node offering an earnable label it has not earned the way a
 *     minting node must (`floor-bypassed`): the label floor counts its runners
 *     as serving the label. The one rule that reads more than the manifest —
 *     the `$proof` state file, for the workload gate.
 *   - a node that declares no `role`, or a typoed one. The role says what the
 *     fleet chain may DO to the box; an unclassified or misspelled one reads as
 *     `claw` at runtime, which for a guest means apt-get on the production host.
 *
 * `--json` is a contract: cron jobs parse this stdout.
 *
 * @guards scripts/admin/fleet-runner-manifest.json
 * @guards src/capabilities.ts
 * @guards scripts/capability-probe.sh
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { readPm2Hosts } from './lib/site-docs.mjs';
import { loadManifest, manifestPath } from './lib/fleet-exec.mjs';
import {
	validateCapabilities,
	parseProbeCapabilities,
	workloadGateContext,
	workloadGatedCapabilities,
} from '../dist/capabilities.js';
import { proofFileStatus, readProofsForCapability } from '../dist/lib/measured.js';
import {
	GUEST_MINT_MODE,
	NODE_ROLES,
	PM2_SERVICES,
	isGuestNode,
	mintsOnDemand,
} from '../dist/lib/node-role.js';
import { keepStdoutWhole } from './lib/emit.mjs';
import { SERVICE_STATE_DIR } from './lib/toolchain-floor.mjs';
import { validateSeeds } from './lib/capability-seeds.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const JSON_OUT = process.argv.includes('--json');
const i = process.argv.indexOf('--manifest');
const MANIFEST = i > -1 ? process.argv[i + 1] : manifestPath();

/**
 * "I could not look" must never render as "nothing is wrong."
 *
 * An unreadable manifest yields zero nodes, and zero nodes yields zero
 * findings — a clean report about a file this gate never opened. So both reads
 * below fail loudly rather than degrading.
 */
function readOrDie(path, what) {
	try {
		return readFileSync(path, 'utf8');
	} catch (err) {
		console.error(`✗ cannot read ${what}: ${path}\n  ${err.message}`);
		console.error(
			'  This is fatal on purpose: an empty manifest produces zero findings, which\n' +
				'  is indistinguishable from a healthy fleet.'
		);
		process.exit(1);
	}
}

let manifest;
try {
	manifest = loadManifest(MANIFEST);
} catch (err) {
	if (err instanceof SyntaxError) {
		console.error(`✗ ${MANIFEST} is not valid JSON: ${err.message}`);
	} else {
		console.error(`✗ cannot read the fleet manifest: ${MANIFEST}\n  ${err.message}`);
		console.error(
			'  This is fatal on purpose: an empty manifest produces zero findings, which\n' +
				'  is indistinguishable from a healthy fleet.'
		);
	}
	process.exit(1);
}

if (!manifest.machines || !Object.keys(manifest.machines).length) {
	console.error(`✗ ${MANIFEST} declares no machines. A fleet of zero is not a pass.`);
	process.exit(1);
}

// Parsed from the probe script's own `say` calls, never from a list kept beside
// it — a verifier that reads its own writer's artifact cannot fail.
const probeText = readOrDie(new URL('capability-probe.sh', import.meta.url), 'capability-probe.sh');
const probeEmits = parseProbeCapabilities(probeText);
if (!probeEmits) {
	console.error(
		'✗ capability-probe.sh yielded no `say <capability>` calls. That is a PARSER\n' +
			'  failure, not an empty probe — reporting it as consistent would hide every\n' +
			'  registry/probe drift at once.'
	);
	process.exit(1);
}

/**
 * Every machine must DECLARE its role, and it must be one the vocabulary knows.
 *
 * WHY HERE AND NOT IN `validateCapabilities`: that function answers "is what
 * this node claims about its CAPABILITIES coherent", and a role is not a
 * capability — it is what the fleet chain may DO to the box. This gate's own
 * header calls itself the home of the declaration-time rules, and this is one.
 *
 * WHY IT IS REQUIRED RATHER THAN DEFAULTED SILENTLY. `nodeRole` defaults an
 * absent role to `claw`, which is the strict direction — a machine nobody
 * classified gets the whole chain. But a default that nothing ever reports is a
 * decision no one made: hokon read as a claw for months and three gates acted on
 * it. So the RUNTIME defaults strict and the GATE insists somebody says it out
 * loud, which is the same split `maxConcurrent` already has (a permissive
 * deployer default, a required-field rule here).
 *
 * An UNKNOWN value is a separate rule from a missing one because they are
 * different jobs: a missing role is a node nobody has classified, and
 * `"gest"` is a node somebody classified and typoed — which silently reads as
 * `claw` and would put the production host back in the chain.
 */
function roleFindings(m) {
	const out = [];
	for (const [name, node] of Object.entries(m.machines ?? {})) {
		const role = node?.role;
		if (role === undefined) {
			out.push({
				rule: 'missing-role',
				machine: name,
				capability: null,
				message:
					`declares no \`role\`. It decides what the fleet chain may DO to this box — ` +
					`converge-toolchain, bootcamp's required set, node-health blocking findings, ` +
					`resident placement, and any repair needing sudo. An absent role reads as ` +
					`"claw" at runtime (the strict direction), so nothing breaks; it just means ` +
					`nobody has said so. Add "role": ${NODE_ROLES.map((r) => `"${r}"`).join(' | ')}.`,
			});
			continue;
		}
		if (!NODE_ROLES.includes(role)) {
			out.push({
				rule: 'unknown-role',
				machine: name,
				capability: null,
				message:
					`declares role "${role}", which is not one of ${NODE_ROLES.join(', ')}. An ` +
					`unrecognised role reads as "claw", so a typo here does not exempt a guest — it ` +
					`puts it back into the fleet chain, which for the production host means an ` +
					`unattended apt-get there.`,
			});
		}
	}
	return out;
}

/**
 * `mint` and `standingRepos` — the on-demand guest's two keys (#120).
 *
 * Both are READ ONLY THROUGH `mintsOnDemand` / `standingRepos`, which answer
 * "no" to anything but the exact shape. That is the safe runtime direction —
 * a typoed `mint` leaves the guest un-minted rather than minted for — and the
 * reason a gate must say so: a guest whose `mint: "on-demnd"` reads as
 * standing would sit with no standing runners (the reconciler retired them
 * under the correct spelling) and nothing minting for it either. A job only it
 * can take would queue with every gate green.
 */
function mintFindings(m) {
	const out = [];
	for (const [name, node] of Object.entries(m.machines ?? {})) {
		const finding = (rule, message) => out.push({ rule, machine: name, capability: null, message });
		if (node?.mint !== undefined) {
			if (node.mint !== GUEST_MINT_MODE) {
				finding(
					'unknown-mint',
					`declares mint "${node.mint}", and the only value is "${GUEST_MINT_MODE}". Anything ` +
						`else reads as a standing guest — with its standing runners possibly retired.`
				);
			} else if (!isGuestNode(node)) {
				finding(
					'mint-off-guest',
					`declares mint "${GUEST_MINT_MODE}" but is not role "guest". A claw mints through ` +
						`\`ephemeral: true\`; this key would mean nothing here, and is not read.`
				);
			}
			if (node.ephemeral === true) {
				finding(
					'mint-and-ephemeral',
					`declares both mint and ephemeral: true. ephemeral is general CI capacity (census, ` +
						`warm cache, placement by speed); an on-demand guest is the last resort. Pick one.`
				);
			}
		}
		if (node?.standingRepos !== undefined) {
			const v = node.standingRepos;
			if (!mintsOnDemand(node)) {
				finding(
					'standing-repos-off-mint',
					`declares standingRepos without mint "${GUEST_MINT_MODE}" on a guest. The list only ` +
						`narrows an on-demand guest's standing registrations, and is not read anywhere else.`
				);
			} else if (
				!Array.isArray(v) ||
				!v.every((r) => typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r))
			) {
				finding(
					'standing-repos-shape',
					`standingRepos must be an array of "owner/repo" strings, got ${JSON.stringify(v)}.`
				);
			}
		}
	}
	return out;
}

/**
 * `services: "pm2"` (#6) — what provisioning owes a node — agrees with
 * hadoku_site's `scripts/pm2-hosts.json`, which decides which boxes host
 * services. Two declarations of one fact, so they are held together here:
 *
 *   services-shape          the only value is "pm2", and never on a guest (the
 *                           fleet does not provision one).
 *   services-not-a-host     declared here, absent from pm2-hosts.json: the box
 *                           would get pm2 and a tunnel daemon and host nothing.
 *   pm2-host-unprovisioned  a non-hub host in pm2-hosts.json without the key:
 *                           nothing would rebuild it on a fresh image — claw-4's
 *                           state from 2026-10-12 to this rule.
 *   state-root-elsewhere    a non-hub host whose `stateRoot` is not
 *                           `~/<SERVICE_STATE_DIR>`, the one directory the
 *                           toolchain floor creates: the wrapper would refuse to
 *                           start over a root nothing provisioned.
 *
 * pm2-hosts.json missing while a node declares `services` is a finding: "I
 * could not look" is not agreement. Missing with nothing declared has nothing
 * to cross-check — every fixture manifest is that case.
 */
function servicesFindings(m) {
	const out = [];
	const finding = (rule, machine, message) =>
		out.push({ rule, machine, capability: null, message });
	const declared = [];
	for (const [name, node] of Object.entries(m.machines ?? {})) {
		if (node?.services === undefined) continue;
		if (node.services !== PM2_SERVICES || isGuestNode(node)) {
			finding(
				'services-shape',
				name,
				`declares services ${JSON.stringify(node.services)}${isGuestNode(node) ? ' on a guest' : ''}; ` +
					`the only value is "${PM2_SERVICES}", on a claw. Provisioning reads nothing else.`
			);
			continue;
		}
		declared.push(name);
	}
	const read = readPm2Hosts();
	if (!read.ok) {
		if (declared.length)
			finding(
				'services-unverifiable',
				null,
				`${declared.join(', ')} declare services "pm2", and pm2-hosts.json could not be read ` +
					`(${read.why}) — not confirmed.`
			);
		return out;
	}
	const { doc, path: file } = read;
	const hosts = Object.keys(doc.hosts ?? {}).filter((h) => h !== doc.hub);
	for (const name of declared)
		if (!hosts.includes(name))
			finding(
				'services-not-a-host',
				name,
				`declares services "pm2" but ${file} lists no such host: it would be provisioned to host nothing.`
			);
	const stateRootShape = new RegExp(`^/home/[^/]+/${SERVICE_STATE_DIR}$`);
	for (const host of hosts) {
		const root = doc.hosts[host]?.stateRoot;
		if (!stateRootShape.test(String(root ?? '')))
			finding(
				'state-root-elsewhere',
				m.machines?.[host] ? host : null,
				`${file} gives ${host} stateRoot ${JSON.stringify(root ?? null)}; the toolchain floor ` +
					`provisions only ~/${SERVICE_STATE_DIR}, so nothing would create it.`
			);
	}
	for (const host of hosts)
		if (!declared.includes(host))
			finding(
				'pm2-host-unprovisioned',
				m.machines?.[host] ? host : null,
				`${file} hosts services on ${host}, and the manifest does not declare services "pm2" ` +
					`there — nothing would rebuild its pm2, boot unit or tunnel daemon on a fresh image.`
			);
	return out;
}

/**
 * THE ONE READ BEYOND THE MANIFEST: the `$proof` state, so `floor-bypassed` can
 * judge a standing node's workload-gated label exactly as the reconciler
 * projects it (`reconcile-fleet-runners.mjs` builds the same context the same
 * way). A corrupt file is the corrupt gate — every gated label withheld — never
 * "no records", which would re-grant what a FAIL/STALE mark withdrew.
 */
const proofStatus = proofFileStatus();
const workloadGate = workloadGateContext(
	Object.keys(manifest.machines),
	Object.fromEntries(
		workloadGatedCapabilities().map((id) => [
			id,
			proofStatus.corrupt ? [] : readProofsForCapability(id),
		])
	),
	{ corrupt: proofStatus.corrupt }
);
if (proofStatus.corrupt) {
	console.error(
		`! $proof is ${proofStatus.reason} (${proofStatus.why}) — every workload-gated label is ` +
			'judged withheld, as the reconciler and the mint withhold it.'
	);
}

const findings = [
	...validateCapabilities(manifest, probeEmits, { workloadGate }),
	...roleFindings(manifest),
	...mintFindings(manifest),
	...servicesFindings(manifest),
	// `$seeds` (#102 wave 4c lane E): earned capabilities come with their
	// artifacts. A SEPARATE validator, merged into the one finding array this
	// gate already emits, rather than a second gate — the shape is identical
	// (`{rule, machine, capability, message}`) so a reader of this output
	// cannot tell which validator produced which finding, and does not need to.
	...validateSeeds(manifest),
];
const nodeCount = Object.keys(manifest.machines).length;

if (JSON_OUT) {
	console.log(JSON.stringify({ manifest: MANIFEST, machines: nodeCount, findings }, null, 2));
} else if (findings.length) {
	console.error(`✗ capability schema (${findings.length} finding(s)) in ${MANIFEST}:\n`);
	for (const f of findings) {
		console.error(`  [${f.rule}] ${f.machine ? `${f.machine}: ` : ''}${f.message}\n`);
	}
} else {
	console.log(
		`✓ ${nodeCount} node(s): every declared capability is in the registry, ` +
			`supported by the node's own specs, and consistent with the probe; ` +
			`every node declares a known \`role\`.`
	);
}

process.exit(findings.length ? 1 : 0);
