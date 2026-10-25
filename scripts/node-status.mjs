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
 *   - `reachable`, `ci`, `hosting.observed` — LIVE, one ssh per node in
 *     parallel during THIS call. `observedAt` is when.
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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { drainNotices, effectiveDrains, HOSTING_NOTICE_MS } from '../dist/runners/drain.js';
import { doctorFindings } from './lib/doctor.mjs';
import { createEmitter } from './lib/emit.mjs';
import { readDrainDoc } from './lib/expected-down.mjs';
import { loadManifest, runOn, selectNodes } from './lib/fleet-exec.mjs';
import { judgeHosting, observeScript, parseObserved } from './lib/hosting.mjs';
import { readRevocations } from '../dist/capability-revocations.js';
import { stateDir } from './lib/paths.mjs';

/** The health writer runs daily; a day and a half covers one late run and no more. */
export const HEALTH_STALE_HOURS = 36;
/** ssh connect, then the whole answer. A node slower than this is unreachable for a tenant's purposes. */
const CONNECT_S = 6;
const ANSWER_MS = 20_000;

const out = createEmitter();
if (process.argv.includes('--help') || process.argv.includes('-h')) {
	out.log('fleet node-status [--json] — per node: reachable, health, drains and notices, hosting.');
	out.log('Live per call (one ssh per node, in parallel); health is the daily doctor record.');
	process.exit(0);
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const manifest = loadManifest();
const { nodes, skippedByRole } = selectNodes(manifest, { argv: process.argv });

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
const notices = drainNotices(doc, NOW);
const health = readHealth();
const revocationRead = readRevocations(stateDir());
const seen = readSeen();

const rows = await Promise.all(
	nodes.map(async ([name, m]) => {
		const observedAt = iso(Date.now());
		const r = await runOn(name, observeScript('cardtable'), {
			timeoutMs: ANSWER_MS,
			connectTimeout: CONNECT_S,
		});
		const obs = parseObserved(r.stdout);
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
		const hostingRec = doc.nodes[name]?.kind === 'hosting' ? doc.nodes[name] : null;
		let hosting = null;
		if (hostingRec) {
			const judged = judgeHosting(hostingRec.hosting ?? {}, obs);
			hosting = { declared: hostingRec.hosting ?? null, observed: judged.observed };
			findings.push(...judged.findings);
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
	out.emit({
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
	});
}
process.exit(ok ? 0 : 1);
