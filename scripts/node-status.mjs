#!/usr/bin/env node
/**
 * fleet node-status — per node: reachable, healthy, drained, hosting. For a
 * TENANT to read, not for the fleet to act on.
 *
 * hadoku-cardtable places Forge matches on the claws and owns every placement
 * decision (its request, docs/requests/FLEET_MANAGER_FORGE_HOSTING.md §4). What
 * it needs from the fleet is facts it can plan around, so that is all this
 * prints. Nothing here ranks or recommends a node.
 *
 * WHAT IS LIVE AND WHAT IS RECORDED, said in the document itself:
 *   - `reachable`, `ci`, `hosting.observed`, `ciUser` — LIVE, ssh to each
 *     node in parallel during THIS call. `observedAt` is when. `ciUser` is
 *     who runs CI there (`lib/node-users-facet.mjs`): `not-cut-over` is the
 *     advisory that jobs run as the admin user, with its sudo; a cut-over
 *     node that drifted is BLOCKING.
 *   - `health` — the daily `fleet doctor --cadence` record (ci:health-refresh,
 *     12:00Z). Its own `recordedAt` and age ride along, and a record past
 *     HEALTH_STALE_HOURS is a BLOCKING finding: an old verdict is not a
 *     current one.
 *   - `drain` and `notices` — the drain file, at this instant: what is held
 *     now, and every scheduled start and end still ahead. A hosting node is
 *     owed HOSTING_NOTICE_MS of notice, so anything that takes one away
 *     appears here at least that long before it happens.
 *
 * "I COULD NOT LOOK" FAILS. An unreachable node is `reachable: false` with a
 * blocking `unreachable` finding and the reason; an answer cut off before its
 * end marker is the same. `ok` per node is "no blocking finding", and the exit
 * code is non-zero when any node is not ok — the document is still printed
 * whole, because under `--json` parseable stdout wins over the exit code.
 *
 * A GUEST IS NOT PROBED. It is listed under `skippedByRole` so its absence is
 * visible; a tenant has no business placing on one.
 *
 * USAGE
 *   fleet node-status            human summary
 *   fleet node-status --json     the document
 *   fleet node-status --json --max-age 60   the last live document, if younger
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { drainNotices, effectiveDrains, HOSTING_NOTICE_MS } from '../dist/runners/drain.js';
import { doctorFindings } from './lib/doctor.mjs';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest, runOn, selectNodes } from './lib/fleet-exec.mjs';
import {
	NO_TENANT,
	judgeHosting,
	observeScript,
	parseObserved,
	peerCandidates,
	probeReach,
} from './lib/hosting.mjs';
import { readRevocations } from '../dist/capability-revocations.js';
import { hostingNotices, readHostingDoc } from '../dist/runners/hosting-record.js';
import { nodeUser } from '../dist/lib/node-users.js';
import {
	judgeNodeUsers,
	parseUsersObservation,
	usersObserveScript,
} from './lib/node-users-facet.mjs';
import { stateDir } from './lib/paths.mjs';
import { readTenantRegistry, tenantSpec } from './lib/tenant-registry.mjs';

/** The health writer runs daily; a day and a half covers one late run and no more. */
export const HEALTH_STALE_HOURS = 36;
/** ssh connect, then the whole answer. A node slower than this is unreachable for a tenant's purposes. */
const CONNECT_S = 6;
const ANSWER_MS = 20_000;

const out = createEmitter();
if (process.argv.includes('--help') || process.argv.includes('-h')) {
	out.log('fleet node-status [--json] — per node: reachable, health, drains and notices, hosting.');
	out.log('Live per call (one ssh per node, in parallel); health is the daily doctor record.');
	out.log(
		'--max-age <sec>: the last whole-fleet document instead, when it is younger (cached: true).'
	);
	process.exit(0);
}

/**
 * The document's version. A tenant pins it (cardtable, 2026-10-28). The rule
 * a reader holds: stdout that parses AND carries `contract` is readable, and
 * anything else is not. The exit code reports findings only, never "could
 * not look". Every change to this document is ADDITIVE; a rename or a retype
 * is a new contract number, told to the tenant first.
 */
export const NODE_STATUS_CONTRACT = 1;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const manifest = loadManifest();
const { nodes, skippedByRole } = selectNodes(manifest, { argv: process.argv });

/**
 * `--max-age <sec>`: a tenant that polls every cycle may take the last live
 * document instead of ~10 s of ssh, when it is younger than that. Only a
 * WHOLE-FLEET call writes or serves it, so a `--machine` answer is never a
 * different selection's. A served copy says `cached: true` and keeps its own
 * `generatedAt`; one that cannot be read is simply not served.
 */
const LAST_FILE = join(stateDir(), 'node-status-last.json');
const maxAgeAt = process.argv.indexOf('--max-age');
const MAX_AGE_S = maxAgeAt > -1 ? Number(process.argv[maxAgeAt + 1]) : null;
if (MAX_AGE_S !== null && !(MAX_AGE_S > 0)) {
	console.error('fleet node-status: --max-age takes a number of seconds above 0');
	process.exit(2);
}
const WHOLE_FLEET =
	nodes.length + skippedByRole.length === Object.keys(manifest.machines ?? {}).length;
if (out.json && MAX_AGE_S !== null && WHOLE_FLEET && existsSync(LAST_FILE)) {
	let last = null;
	try {
		last = JSON.parse(readFileSync(LAST_FILE, 'utf8'));
	} catch (err) {
		out.warn(`${LAST_FILE} is unreadable (${err.message}); answering live.`);
	}
	if (
		last?.contract === NODE_STATUS_CONTRACT &&
		NOW - Date.parse(last.generatedAt) <= MAX_AGE_S * 1000
	) {
		out.emit({ ...last, cached: true });
		process.exit(last.ok ? 0 : 1);
	}
}

/** Every node's last successful answer, so an unreachable one says how long it has been gone. */
const SEEN_FILE = join(stateDir(), 'node-status-seen.json');
function readSeen() {
	if (!existsSync(SEEN_FILE)) return {};
	try {
		return JSON.parse(readFileSync(SEEN_FILE, 'utf8'));
	} catch (err) {
		// Losing last-seen times costs a field, not a verdict: reachability is
		// judged live. Say so rather than pretend the file was empty.
		out.warn(`${SEEN_FILE} is unreadable (${err.message}); last-seen times start over.`);
		return {};
	}
}

/** The daily health record, or why there is none. */
function readHealth() {
	const p = join(stateDir(), 'health.json');
	try {
		return { nodes: JSON.parse(readFileSync(p, 'utf8')).nodes ?? {}, why: null };
	} catch (err) {
		return { nodes: {}, why: `${p}: ${err.message}` };
	}
}

const doc = readDrainDoc();
const held = effectiveDrains(doc, NOW);
// Shared hosting slices. An unreadable record is "could not look": every node
// is blocked on it, because no reader can tell which tenant is where.
let hostingDoc = { nodes: {} };
let hostingUnreadable = null;
try {
	hostingDoc = readHostingDoc(stateDir());
} catch (err) {
	hostingUnreadable = err.message;
}
// The registered tenants: what each hosted tenant's units, user and port are.
// Unreadable is the same "could not look" as an unreadable hosting record.
let registry = { tenants: {} };
try {
	registry = readTenantRegistry(stateDir());
} catch (err) {
	hostingUnreadable = hostingUnreadable ?? `tenant registry: ${err.message}`;
}
/** The tenant hosted on a node, whole-box or shared, or null. */
const hostedTenant = (name) =>
	(doc.nodes[name]?.kind === 'hosting' ? doc.nodes[name].hosting?.tenant : null) ??
	hostingDoc.nodes[name]?.tenant ??
	null;
const notices = [...drainNotices(doc, NOW), ...hostingNotices(hostingDoc, NOW)].sort(
	(a, b) => Date.parse(a.at) - Date.parse(b.at)
);

/**
 * Boots seen per node, to catch a hosting node rebooted WITHOUT notice
 * (cardtable §7, A8). A reboot is announced when the previous observation saw
 * a `reboot` drain on the node, in force or planned. The reboot cycle and a
 * planned `fleet drain --kind reboot` both write one; a `--force` or a hand
 * reboot does not, and that is the case the tenant alerts on.
 */
const BOOTS_FILE = join(stateDir(), 'node-status-boots.json');
const UNANNOUNCED_REPORT_MS = 24 * 3_600_000;
function readBoots() {
	if (!existsSync(BOOTS_FILE)) return {};
	try {
		return JSON.parse(readFileSync(BOOTS_FILE, 'utf8'));
	} catch (err) {
		out.warn(`${BOOTS_FILE} is unreadable (${err.message}); reboot history starts over.`);
		return {};
	}
}
const boots = readBoots();
const rebootDrainOn = (name) =>
	held[name]?.kind === 'reboot' || doc.planned.some((p) => p.node === name && p.kind === 'reboot');
const health = readHealth();
const revocationRead = readRevocations(stateDir());
const seen = readSeen();

const rows = await Promise.all(
	nodes.map(async ([name, m]) => {
		const observedAt = iso(Date.now());
		const spec = hostedTenant(name) ? tenantSpec(registry, hostedTenant(name)) : null;
		const r = await runOn(name, observeScript(spec ?? NO_TENANT, nodeUser(m, 'ci')), {
			as: 'admin',
			timeoutMs: ANSWER_MS,
			connectTimeout: CONNECT_S,
		});
		const obs = parseObserved(r.stdout);
		const usersRun = await runOn(name, usersObserveScript(m), {
			as: 'admin',
			timeoutMs: ANSWER_MS,
			connectTimeout: CONNECT_S,
		});
		const users = judgeNodeUsers(m, parseUsersObservation(usersRun.stdout));
		const findings = [];
		if (!obs) {
			findings.push({
				class: 'blocking',
				category: 'unreachable',
				why: r.ok
					? 'the node answered but its answer stopped short'
					: r.stderr.trim() || r.error || 'no answer',
			});
		} else seen[name] = observedAt;

		const h = health.nodes[name];
		let healthOut;
		if (!h) {
			healthOut = { recordedAt: null, ageHours: null };
			findings.push({
				class: 'blocking',
				category: 'health-missing',
				why: health.why ?? 'no health record for this node',
			});
		} else {
			const ageHours = Math.round(((NOW - Date.parse(h.at)) / 3_600_000) * 10) / 10;
			healthOut = { recordedAt: h.at, ageHours };
			if (!(ageHours <= HEALTH_STALE_HOURS)) {
				findings.push({
					class: 'blocking',
					category: 'health-stale',
					why: `the health record is ${ageHours} h old, past ${HEALTH_STALE_HOURS} h — the writer has stopped`,
				});
			}
			for (const f of doctorFindings(h, { nowMs: NOW })) {
				findings.push({ class: f.class, category: f.category, why: f.why });
			}
		}

		// A label a probe executed and judged failed is withheld from routing
		// (src/capability-revocations.ts). Advisory: the node still runs what it
		// can; it no longer advertises what it cannot.
		const revoked = revocationRead.corrupt
			? null
			: Object.entries(revocationRead.nodes[name] ?? {}).map(([capability, r]) => ({
					capability,
					...r,
				}));
		if (revocationRead.corrupt) {
			findings.push({
				class: 'advisory',
				category: 'revocations-unreadable',
				why: `the revocation record is unreadable (${revocationRead.why}); every probe-verified label is withheld`,
			});
		}
		for (const r of revoked ?? []) {
			findings.push({
				class: 'advisory',
				category: 'label-revoked',
				why: `${r.capability} withheld since ${r.at}: ${r.reason}`,
			});
		}

		const rec = held[name] ?? null;
		const wholeRec = doc.nodes[name]?.kind === 'hosting' ? doc.nodes[name] : null;
		const sharedRec = hostingDoc.nodes[name] ?? null;
		let hosting = null;
		if (hostingUnreadable) {
			findings.push({
				class: 'blocking',
				category: 'hosting-unreadable',
				why: `the shared hosting record is unreadable (${hostingUnreadable}), so whether a tenant is here is unknown`,
			});
		}
		if (wholeRec || sharedRec) {
			const mode = wholeRec ? 'whole' : 'shared';
			const r0 = wholeRec ?? sharedRec;
			const declared = wholeRec
				? (wholeRec.hosting ?? {})
				: {
						tenant: r0.tenant,
						memoryMb: r0.memoryMb,
						cores: r0.cores,
						port: r0.port,
						// A hot standby (availability.standby); absent = the primary, as before.
						...(r0.role ? { role: r0.role } : {}),
					};
			// Reach is a `controller` ingress's question; a loopback tenant is judged from its socket.
			const reach =
				obs && spec?.ingress === 'controller'
					? await probeReach({
							port: declared.port,
							addrs: {
								lan: m.lan?.ip ?? null,
								tailnet4: obs.tailnet4,
								tailnet6: obs.tailnet6,
							},
							peers: peerCandidates(manifest, name),
							run: runOn,
						})
					: null;
			const judged = judgeHosting(declared, obs, mode, reach, spec);
			// `state` is hosting --check's word for the same judgement, so a tenant
			// reads one vocabulary from both (cardtable lane D, TENANT_CONTRACT).
			const state = judged.findings.some((f) => f.class === 'blocking')
				? 'not-guaranteed'
				: 'guaranteed';
			hosting = { mode, state, declared, until: r0.until ?? null, observed: judged.observed };
			findings.push(...judged.findings);
		}

		// Unreachable is already one blocking finding above; the users facet adds its
		// own only when the node answered.
		if (obs) findings.push(...users.findings);

		// A hosting node rebooted without notice. Recorded for every node, so a
		// node that becomes a host already has a boot to compare against.
		const prev = boots[name];
		if (obs?.bootId) {
			let unannounced = prev?.unannounced ?? null;
			if (prev?.bootId && prev.bootId !== obs.bootId && prev.hosting && !prev.rebootDrain) {
				unannounced = {
					at: observedAt,
					from: prev.bootId,
					to: obs.bootId,
					lastSeenBefore: prev.at,
				};
			}
			boots[name] = {
				bootId: obs.bootId,
				at: observedAt,
				hosting: Boolean(wholeRec || sharedRec),
				rebootDrain: rebootDrainOn(name),
				...(unannounced ? { unannounced } : {}),
			};
			if (unannounced && NOW - Date.parse(unannounced.at) < UNANNOUNCED_REPORT_MS) {
				findings.push({
					class: 'advisory',
					category: 'hosting-unannounced-reboot',
					why: `rebooted while hosting with no reboot drain ahead of it (seen ${unannounced.at}, previous answer ${unannounced.lastSeenBefore})`,
				});
			}
		}

		return {
			node: name,
			ok: !findings.some((f) => f.class === 'blocking'),
			reachable: Boolean(obs),
			observedAt,
			lastSeenAt: seen[name] ?? null,
			uptimeSec: obs?.uptimeSec ?? null,
			ci: obs ? { workers: obs.ciWorkers, listeners: obs.ciListeners } : null,
			drain: rec
				? {
						kind: rec.kind ?? 'maintenance',
						reason: rec.reason,
						since: rec.since,
						until: rec.until ?? null,
					}
				: null,
			notices: notices.filter((n) => n.node === name).map(({ node: _, ...n }) => n),
			hosting,
			ciUser: { name: nodeUser(m, 'ci'), state: users.state },
			capabilities: m.$capabilities?.earned ?? [],
			revoked,
			health: healthOut,
			findings,
		};
	})
);

try {
	mkdirSync(dirname(SEEN_FILE), { recursive: true });
	writeFileSync(SEEN_FILE, `${JSON.stringify(seen, null, 2)}\n`);
	writeFileSync(BOOTS_FILE, `${JSON.stringify(boots, null, 2)}\n`);
} catch (err) {
	out.warn(`could not record last-seen times: ${err.message}`);
}

rows.sort((a, b) => a.node.localeCompare(b.node));
for (const r of rows) {
	const drain = r.drain
		? ` ${r.drain.kind}${r.drain.until ? ` until ${r.drain.until.slice(0, 16)}Z` : ''}`
		: '';
	const blocking = r.findings.filter((f) => f.class === 'blocking');
	out.log(
		`${r.node.padEnd(8)} ${r.reachable ? 'up  ' : 'DOWN'} ${r.ok ? 'ok     ' : 'BLOCKED'}${drain}` +
			(blocking.length ? `  — ${blocking.map((f) => f.category).join(', ')}` : '')
	);
	for (const n of r.notices)
		out.log(`         ${n.kind} ${n.event} ${n.at.slice(0, 16)}Z — ${n.reason}`);
}
for (const s of skippedByRole) out.log(`${s.node.padEnd(8)} not probed: ${s.why}`);

const ok = rows.length > 0 && rows.every((r) => r.ok);
if (out.json) {
	const document = {
		contract: NODE_STATUS_CONTRACT,
		ok,
		generatedAt: iso(NOW),
		freshness: {
			live: 'reachable, ci and hosting.observed are observed during this call; see each observedAt',
			healthRecord: `daily (ci:health-refresh, 12:00Z); blocking past ${HEALTH_STALE_HOURS} h`,
			noticeMinutes: HOSTING_NOTICE_MS / 60_000,
		},
		nodes: rows,
		skippedByRole,
		lines: out.held(),
	};
	if (WHOLE_FLEET) {
		try {
			writeFileSync(LAST_FILE, `${JSON.stringify(document)}\n`);
		} catch (err) {
			out.warn(`could not keep the document for --max-age: ${err.message}`);
		}
	}
	out.emit({ ...document, cached: false });
}
process.exit(ok ? 0 : 1);
