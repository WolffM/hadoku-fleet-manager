#!/usr/bin/env node
/**
 * doctor-run — the I/O half of `fleet doctor`: reach every node, record
 * `$health`, print the findings.
 *
 * `src/cli.ts`'s `doctor` row points straight here. A bash door,
 * `claw-doctor.sh`, sat in front of it until 2026-10-12 only because no lane
 * owned that row; it went when `doctor` came under the `--json` contract
 * (ci:health-refresh), whose gates read the script the row names. The split is the one
 * `check-fleet-preflight.mjs` / `preflight.mjs` already use: every judgement and
 * every threshold lives in `doctor.mjs` and is tested against captured node
 * output; this file owns ssh, the record read, the record write, and the
 * rendering.
 *
 * WHERE THE RECORD LIVES (Wave 3h)
 * --------------------------------
 * `<stateDir>/health.json`, through `src/lib/measured.ts` — not the manifest.
 * The reader merges: the state dir first, the manifest's older `$health` while
 * the migration is in flight, and every rendered record says which tree
 * answered (`from`). `--write` therefore needs NO commit and no longer goes
 * through `lib/manifest-target.mjs`: the deploy-tree refusal exists because a
 * write into a checkout that every publish resets is erased, and the state dir
 * is not a checkout. Not one manifest byte is written here any more.
 *
 * WHY THE OLD SHELL LOOP COULD NOT STAY
 * -------------------------------------
 * `claw-doctor.sh` hard-coded `CLAWS=(claw-1 claw-2 claw-3)` and ran a bare
 * `ssh "$c"` on each. Both halves of that are wrong now for reasons CLAUDE.md
 * names outright:
 *
 *   - THE ROSTER IS THE MANIFEST'S. Three node names typed into a script were
 *     the whole fleet in August; the fleet is eight claws and hokon today, so
 *     `fleet doctor` with no argument reported health for a third of it and
 *     exited 0. "Exit 0 with no evidence is a failure."
 *   - `ssh` IS NOT THE ONLY TRANSPORT. hokon refuses ssh to itself, so the old
 *     loop read the production host as permanently UNREACHABLE — verified again
 *     while writing this: `ssh hokon true` answers `Connection refused`.
 *     `isLocalNode()` in `src/lib/node-identity.ts` is the one place that
 *     question may be asked, and `fleet-exec.mjs`'s `runOn` is the one transport
 *     that asks it.
 *
 * USAGE
 *   fleet doctor                      # every managed node, 60s load each
 *   fleet doctor --machine claw-7     # one node
 *   fleet doctor --no-load            # skip the load phase (says so in $health)
 *   fleet doctor --force              # load a node even while CI builds on it
 *   fleet doctor --write              # record <stateDir>/health.json nodes[node]
 *   fleet doctor --cadence --write    # the scheduled run (ci:health-refresh)
 *   fleet doctor --from-record        # render from the RECORD, probe nothing
 *                                     # (`--from-manifest`: the old spelling)
 *   fleet doctor --json
 *
 * `--cadence` IS THE SCHEDULED RUN, and it exists because `$health` had no
 * scheduled writer at all: one hand run on 2026-09-26 wrote every record, and on
 * 2026-10-11 `ci:health-freshness` found all nine 15.3 days old. Two rules make
 * a hand run unfit to schedule, and `--cadence` changes exactly those two:
 *
 *   - A BUSY NODE IS DEFERRED, NOT FAILED. Doctor skips the load phase while CI
 *     builds on a box, and the missing reading is a BLOCKING `no-load-reading`.
 *     That is right for an operator, who can re-run when the box is idle, and
 *     wrong for a cron, which would page whenever a claw happened to be busy at
 *     12:00 UTC. A deferred node's finding is advisory, and its record is NOT
 *     rewritten: a fresh record with no under-load reading would replace the
 *     last real one and leave a blocking finding in the stored record, and
 *     provisioning refuses a node on exactly that. The node keeps its older,
 *     dated record, so a box that stays busy every night still goes red at
 *     `fleet health-freshness`'s 14 days, with the reason.
 *   - A GUEST IS NEVER LOADED. See `GUEST_CADENCE_NO_LOAD_WHY` in doctor.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { loadManifest, machineArg, runOn, selectMachines } from './fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './expected-down.mjs';
import { createEmitter } from './emit.mjs';
import {
	ADVISORY,
	LOAD_SECONDS,
	advisoryFindings,
	blockingFindings,
	bootcampPointer,
	doctorFindings,
	doctorProbe,
	GUEST_CADENCE_NO_LOAD_WHY,
	guestAdvisory,
	healthFacet,
	healthRecord,
	parseDoctor,
} from './doctor.mjs';
import { guestNodeNames } from '../../dist/lib/node-role.js';
import { nodeUser } from '../../dist/lib/node-users.js';
import { readHostingDoc } from '../../dist/runners/hosting-record.js';
import { pm2Peers, tenantsByNode } from './collect-offers.mjs';
import { readDrainDoc } from './expected-down.mjs';
import { claimPm2Units } from './hosting-claims.mjs';
import { readTenantRegistry, tenantSpecFrom } from './tenant-registry.mjs';
import { heldByCycle } from './reboot-cycle.mjs';
import { stateDir } from './paths.mjs';
import { measuredFacets, writeFacet } from '../../dist/lib/measured.js';

// Through the shared emitter, which every subcommand under the `--json`
// contract uses: the document below is printed and `process.exit` runs on the
// next line, and into a PIPE that abandons everything past the first 8 KB —
// eight nodes of `$health` are far past it (issue #33).
const emitter = createEmitter({ argv: process.argv });

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FROM_RECORD = argv.includes('--from-record') || argv.includes('--from-manifest');
if (FROM_RECORD && WRITE) {
	// A record read back out of the record is not a measurement. Writing it
	// could only copy this reader's input into the writer's output — the
	// verifier-reads-its-own-writer loop CLAUDE.md forbids — and would stamp a
	// manifest-served copy into the state dir as if something had probed it.
	console.error(
		'fleet doctor: --write records a PROBE and --from-record probes nothing. Run one or the other.'
	);
	process.exit(2);
}
const NO_LOAD = argv.includes('--no-load');
const CADENCE = argv.includes('--cadence');
if (CADENCE && (FROM_RECORD || NO_LOAD || argv.includes('--force'))) {
	// Each of these would make the scheduled run something other than the
	// measurement it promises: no probe, no load anywhere, or a load on top of a
	// running job.
	console.error('fleet doctor: --cadence takes none of --from-record, --no-load or --force.');
	process.exit(2);
}
const FORCE = argv.includes('--force');
const SECONDS = (() => {
	const i = argv.indexOf('--seconds');
	if (i === -1) return LOAD_SECONDS;
	const v = Number(argv[i + 1]);
	if (!Number.isFinite(v) || v < 0) {
		console.error('fleet doctor: --seconds needs a non-negative number of seconds.');
		process.exit(1);
	}
	return v;
})();
// `--machine`, the one spelling, same refusal every other subcommand gives. A
// bare positional is IGNORED by this parser, which silently widens the run to
// the whole fleet — and `fleet doctor claw-1` is exactly what an operator types.
const ONLY = machineArg(argv, { valueFlags: ['--seconds'] });

const log = (m) => emitter.log(m);

const manifest = loadManifest();
const nodes = selectMachines(manifest, { only: ONLY });
if (!nodes.length) {
	console.error(`fleet doctor: no managed node matches ${ONLY ?? '(any)'}`);
	process.exit(1);
}

const PROBE = doctorProbe({ loadSeconds: NO_LOAD ? 0 : SECONDS, force: FORCE });
const GUESTS = guestNodeNames(manifest);
const PROBE_ATTEMPTS = 2;
const GUEST_CADENCE_PROBE = doctorProbe({ loadSeconds: 0, noLoadWhy: GUEST_CADENCE_NO_LOAD_WHY });
const probeFor = (name) => (CADENCE && GUESTS.has(name) ? GUEST_CADENCE_PROBE : PROBE);
const at = new Date().toISOString();
/** @type {Record<string, object>} */
const health = {};
const unreachable = [];

if (FROM_RECORD) {
	// THE RENDER-FROM-RECORD PATH, and the reason it exists: §H's third
	// done-when is "the inventory page can be rendered from it". A page cannot
	// ssh to eight boxes to draw a row, so the record has to carry everything the
	// row needs. This path proves it does by drawing the same table with the
	// probe switched off entirely — if a column can only be filled by a live
	// probe, it renders blank here and the claim is false.
	//
	// The record is `measured.ts`'s merge, and a node with NO usable record is
	// not a blank healthy row: it is "could not look", with the reason, and it
	// fails the run. A missing `health.json` is exactly that for every node the
	// manifest does not still cover.
	const stored = measuredFacets('health', manifest.machines ?? {});
	for (const [name, m] of nodes) {
		const r = stored.nodes[name];
		if (r.unavailable) {
			unreachable.push(name);
			health[name] = {
				node: name,
				reachable: false,
				at: null,
				by: null,
				why:
					r.unavailable === 'unreadable' || r.unavailable === 'malformed'
						? `this node's $health record is UNREADABLE (${r.unavailable}) — ${r.why}`
						: `this node carries no $health record (${r.unavailable}); nothing has run ` +
							`\`fleet doctor --write\` for it — ${r.why}`,
			};
			continue;
		}
		health[name] = {
			...r.value,
			node: name,
			from: r.from,
			// Re-derived from the CURRENT manifest, never read out of the record —
			// see `bootcampPointer` in doctor.mjs.
			bootcamp: bootcampPointer(m.$capabilities ?? null),
		};
	}
} else {
	await Promise.all(
		nodes.map(async ([name, m]) => {
			// A 60s load plus sampling plus smartctl; the ceiling is generous
			// because a timeout here reads as an unreachable node, and a node
			// wrongly called unreachable is the failure this repo has paid for most.
			// TWO ATTEMPTS, the `READ_ATTEMPTS` rule: on 2026-10-12 claw-1's probe
			// died at this ceiling with no reason, and a re-probe a minute later
			// finished in 67s. Retrying is not tolerating — a node that fails both
			// is still unreachable, and still a finding.
			let r;
			let probe;
			for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
				r = await runOn(name, probeFor(name), {
					as: 'admin',
					timeoutMs: 240_000,
					maxBuffer: 8 * 1024 * 1024,
				});
				probe = parseDoctor(r.out);
				if (probe.complete) break;
			}
			if (!probe.complete) {
				unreachable.push(name);
				health[name] = healthFacet({
					node: name,
					probe,
					reachable: false,
					unreachableReason:
						`the probe never printed DOCTOR-END over ${r.local ? 'a local shell' : 'ssh'} in ` +
						`${PROBE_ATTEMPTS} attempts: ` +
						`${r.error ?? 'the node produced no sentinel'}. That is silence, not an empty ` +
						'result — a node that died partway through prints plenty and finishes nothing.',
					at,
				});
				return;
			}
			health[name] = healthFacet({
				node: name,
				probe,
				capabilities: m.$capabilities ?? null,
				at,
			});
		})
	);
}

// ── cadence deferrals ────────────────────────────────────────────────────────
// A reachable non-guest that was building when probed, so no load was taken.
// See the header: advisory, and its record is kept rather than rewritten.
const deferred = new Set(
	CADENCE
		? Object.entries(health)
				.filter(
					([name, h]) =>
						h.reachable !== false &&
						!GUESTS.has(name) &&
						(h.runners?.busy ?? 0) > 0 &&
						(h.thermal?.loadC ?? null) === null
				)
				.map(([name]) => name)
		: []
);

// ── who claims each pm2 manager ──────────────────────────────────────────────
// A join against the controller's records, made here on every run and never
// stored (`healthRecord`), so the render-from-record path judges the stored
// units against the records as they are NOW.
const claimRecords = (() => {
	try {
		const registry = readTenantRegistry(stateDir());
		return {
			tenants: Object.values(registry.tenants).map((e) => tenantSpecFrom(e.request)),
			declared: tenantsByNode(readDrainDoc(), readHostingDoc(stateDir())),
			unreadable: null,
		};
	} catch (e) {
		return {
			tenants: [],
			declared: new Map(),
			unreadable: `the hosting records are unreadable: ${e.message}`,
		};
	}
})();
const appLayerHosts = pm2Peers();
for (const [name, h] of Object.entries(health)) {
	if (!h.pm2Units?.units) continue;
	h.pm2Claims = claimPm2Units({
		units: h.pm2Units.units,
		tenants: claimRecords.tenants,
		declaredHere: (claimRecords.declared.get(name) ?? []).map((t) => t.tenant),
		appLayer: {
			unit: `pm2-${nodeUser(manifest.machines?.[name], 'admin')}.service`,
			host: appLayerHosts.set === null ? null : appLayerHosts.set.has(name),
		},
		unreadable: claimRecords.unreadable,
	});
	if (appLayerHosts.set === null) {
		for (const c of h.pm2Claims)
			if (c.claim === 'unknown') c.why = `${c.why}: ${appLayerHosts.why}`;
	}
}

// ── the reboot cycle's decisions ─────────────────────────────────────────────
// The cycle (fleet reboot-claws, run hourly by the controller) acts; this
// reports what it last decided beside the staged flag. A held node stays
// visible after its flag clears, which is exactly when it needs a human.
// A `held` decision counts only while the drain file still carries the hold:
// a human who lifted it has answered it, whatever the last pass wrote.
const drains = readDrains();
const cycleDecisions = readCycleDecisions();
for (const [name, h] of Object.entries(health)) {
	const d = cycleDecisions[name];
	if (!d || h.reachable === false) continue;
	if (d.status === 'held' && !heldByCycle(drains[name])) continue;
	if (h.reboot?.required || d.status === 'held') h.reboot = { ...h.reboot, cycle: d };
}

/** The cycle's per-node decisions, or `{}` when it has never run here. */
function readCycleDecisions() {
	const path = join(stateDir(), 'claw-reboot.json');
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')).decisions ?? {};
	} catch (e) {
		log(
			`\n· the reboot cycle's state at ${path} is unreadable (${e.message}); its decisions are not shown`
		);
		return {};
	}
}

// ── findings ─────────────────────────────────────────────────────────────────
const findings = [];
for (const [name, h] of Object.entries(health).sort()) {
	// A NODE A HUMAN POWERED OFF, IN WRITING, RECENTLY. Same narrow exception
	// `bootcamp.mjs` and `expected-down.mjs` make and no wider: a dated
	// maintenance drain is printed and not counted, and it expires. claw-8 is the
	// live case — its cooler does not transfer heat and it is off pending a part.
	if (h.reachable === false) {
		const def = deferralFor(name, drains);
		if (def.deferred) {
			log(`\n· ${deferralNote(name, def)} — not probed`);
			continue;
		}
	}
	for (const fd of doctorFindings(h)) {
		if (deferred.has(name) && fd.category === 'cpu-thermal' && fd.status === 'no-load-reading') {
			findings.push({
				...fd,
				class: ADVISORY,
				why:
					`${fd.why} DEFERRED by --cadence: CI was building here, so this run did not ` +
					'rewrite the record; the previous one stands and keeps ageing.',
			});
			continue;
		}
		findings.push(fd);
	}
}

// A GUEST'S NODE HEALTH DOES NOT FAIL THIS RUN — `machines[<node>].role`, the
// operator's scoping decision of 2026-09-14, through the one implementation
// `check-fleet-preflight` also uses. Nothing is dropped: the finding keeps its
// `why`, gains `role: 'guest'`, and rides in `advisory`. `unreachable` stays
// blocking even here (GUEST_BLOCKING_CATEGORIES): the one question a guest IS
// in scope for cannot be answered about a box nothing can reach.
const classified = guestAdvisory(findings, GUESTS);
const blocking = blockingFindings(classified);
const advisory = advisoryFindings(classified);

// ── render ───────────────────────────────────────────────────────────────────
const C = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

for (const [name, h] of Object.entries(health).sort()) {
	if (h.reachable === false) {
		const def = deferralFor(name, drains);
		if (def.deferred) continue;
		log(`\n══ ${name}  UNREACHABLE`);
		log(`   ${h.why}`);
		continue;
	}
	const t = h.thermal ?? {};
	const s = h.smart ?? {};
	const d = h.disk ?? {};
	const n = h.network ?? {};
	log(`\n══ ${name}  ${h.product ?? '?'}  kernel ${h.kernel ?? '?'}`);
	log(
		`   cpu       ${C(t.idleC, '°C')} idle → ${C(t.loadC, '°C')} under ${C(t.loadSeconds, 's')} ` +
			`load on ${C(t.loadWorkers)} cores   (${t.sensor ?? 'no die sensor'}; throttle +${C(t.throttleEvents)})`
	);
	if (t.loadWhy) log(`             no load reading: ${t.loadWhy}`);
	log(
		`   disk      / ${C(d.freePct, '%')} free of ${C(d.totalKb && Math.round(d.totalKb / 1024 / 1024), 'GiB')} ` +
			`on ${C(d.device)} (${C(d.fs)})`
	);
	log(
		`   smart     ${C(s.health)}  ${C(s.powerOnHours && s.powerOnHours.toLocaleString('en-US'))}h  ` +
			`${C(s.temperatureC, '°C')}  life ${C(s.lifetimeRemainingPct, '%')}${s.why ? `  — ${s.why}` : ''}`
	);
	log(
		`   network   wifi ${C(n.wifiManager)}${n.radio ? ` on ${n.radio} (${C(n.operstate)}` : ' ('}` +
			`${n.ssid ? ` ssid ${n.ssid}` : ''}${n.signalDbm ? ` ${n.signalDbm}dBm` : ''})`
	);
	log(
		`   runners   ${C(h.runners?.registered)} registered, ${C(h.runners?.failed)} failed, ` +
			`${C(h.runners?.busy)} building   watchdog ${C(h.watchdog?.active)}`
	);
	log(
		`   bootcamp  ${C(h.bootcamp?.verdict)} at ${C(h.bootcamp?.at)}  earned ${(h.bootcamp?.earned ?? []).length}`
	);
	log(
		`   reboot    ${h.reboot?.required ? `REQUIRED since ${h.reboot.stagedAt}` : 'not required'}` +
			`   uptime ${C(h.uptimeSec && Math.round(h.uptimeSec / 3600), 'h')}`
	);
}

if (findings.length) {
	log('');
	for (const fd of findings.sort(
		(a, b) =>
			`${a.node}${a.class === ADVISORY ? 1 : 0}`.localeCompare(
				`${b.node}${b.class === ADVISORY ? 1 : 0}`
			) || a.category.localeCompare(b.category)
	)) {
		log(
			`${fd.class === ADVISORY ? 'advisory' : 'BLOCKING'}  ${fd.node}  ${fd.category}/${fd.status}`
		);
		log(`          ${fd.why}`);
	}
}

// ── the record ───────────────────────────────────────────────────────────────
/** The nodes whose record THIS run replaced — the writer's own evidence. */
let written = [];
if (WRITE) {
	/** @type {Record<string, object>} */
	const records = {};
	let kept = 0;
	for (const [name, h] of Object.entries(health)) {
		if (!manifest.machines?.[name]) continue;
		if (deferred.has(name)) {
			kept++;
			continue;
		}
		// A NODE THIS RUN COULD NOT REACH KEEPS WHATEVER `$health` IT ALREADY HAD.
		// Verbatim the rule `bootcamp.mjs`'s `$capabilities` write states: "I could
		// not look" must not render as "nothing is here", and overwriting a real
		// record with silence is the exact inversion the rule exists against. The
		// stale record is still dated, so a reader can see how old it is; a record
		// replaced by `reachable: false` would have destroyed the last known good
		// reading of a box that is merely off for the evening. `writeFacet` merges
		// into the file, so a node left out of `records` keeps its block.
		if (h.reachable === false) {
			kept++;
			continue;
		}
		// WITHOUT the bootcamp pointer — it is re-derived on read, never stored.
		records[name] = healthRecord(h);
	}
	written = Object.keys(records).sort();
	const count = written.length;
	if (count) {
		// THE STATE DIR, NO COMMIT. `writeFacet` REFUSES a health.json that exists
		// and cannot be read, rather than replacing it with this run's subset and
		// destroying the other nodes' readings with nothing said.
		const w = writeFacet('health', records);
		if (!w.ok) {
			console.error(`fleet doctor: $health NOT recorded — ${w.reason}: ${w.why}`);
			process.exit(1);
		}
		log(
			`\n✓ recorded $health on ${count} node(s) in ${w.path}` +
				`${kept ? `; ${kept} unreachable or deferred node(s) kept the record they already had` : ''}` +
				`\n  logged to ${w.logPath}. No commit: the state dir is not a checkout.`
		);
	} else {
		log(`\n  nothing written — no node was reachable, and silence never overwrites a record`);
	}
}

if (emitter.json) {
	emitter.emit({
		ok: blocking.length === 0,
		at,
		nodes: Object.keys(health).sort(),
		health,
		findings,
		blocking: blocking.length,
		advisory: advisory.length,
		unreachable,
		cadence: CADENCE,
		written,
		deferred: [...deferred].sort(),
		log: emitter.held(),
	});
} else if (!findings.length) {
	log(`\n✓ every node reported, and nothing is wrong with any of them`);
} else {
	log(
		`\n${blocking.length} blocking, ${advisory.length} advisory across ${Object.keys(health).length} node(s)`
	);
}

process.exit(blocking.length ? 1 : 0);
