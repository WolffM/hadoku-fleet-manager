#!/usr/bin/env node
/**
 * converge-toolchain — check, and optionally REFRESH, what every node can build.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fleet already had a good "is it there" story and no "put it there" story.
 * `check-fleet-toolchain` reports drift against the manifest and installs
 * nothing; `node-profiles.json` declares the package set but only IMAGES a box,
 * at enrollment, once. Everything in between was a human with ssh in a for-loop.
 *
 * That gap is not theoretical. On 2026-09-10 moving brave-quartet and
 * kate-plugin onto the fleet needed rustup, Bevy's -dev libs and the KF6/Qt6
 * headers on seven machines, and every one of those went on by hand. A node
 * enrolled the next day would have had none of it, and nothing would have said
 * so until a job failed on that node and passed on its neighbours — the exact
 * "flaky test" shape that hid the python3-venv drift for as long as anyone had
 * been re-running it.
 *
 * So: one door for both questions. Read-only by default (exit 1 on drift, so a
 * cron can page), `--write` converges.
 *
 * THE VERIFIER MAY NOT READ ITS OWN WRITER'S ARTIFACT
 * ---------------------------------------------------
 * `--write` does not report what it installed. It re-runs the PROBE afterwards
 * and reports what the node can now DO. An installer's exit code is the
 * writer's account of itself; `capability-probe.sh` executes the capability.
 * A convergence that trusted apt's exit status would go green on a package that
 * installed fine and left the binary unreachable — which is precisely the bug
 * that shipped on 2026-09-10 (see REPAIRS.rust below).
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Nothing here is a substitute for the profile. `node-profiles.json` remains
 * the declaration; this reads it. Adding a package here instead of there would
 * make a freshly imaged node depend on someone remembering to run this.
 *
 * AND IT DOES NOT TOUCH A GUEST. `machines[<node>].role` says what the fleet
 * chain may do to a box; `guest` means it lends the fleet a registration and
 * nothing else. hokon is the only one, and it is the production host — an
 * unattended `apt-get install` there is the specific damage this skip prevents.
 * The skip prints and rides in `--json`, because a silent skip is how a node
 * stops being checked and nobody notices. `--include-guests` overrides it for
 * one run.
 */

import { writeFileSync } from 'node:fs';
import { loadManifest, machineArg, runOnSync, separateCiUser } from './lib/fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { createEmitter } from './lib/emit.mjs';
import {
	REPAIRS,
	applicableRepairs,
	declaredPackages,
	installScript,
	isVersionManaged,
	parseObservation,
	resolveInstallTarget,
} from './lib/toolchain-floor.mjs';
import { createLiveDeps, runRefreshCycle } from './lib/refresh-cycle.mjs';
import { defaultSeedDeps, isSeedFinding, seedNode } from './lib/capability-seeds.mjs';
import {
	TOKEN_ENV,
	cloudflare,
	convergeTunnels,
	healthStatus,
	readSiteDocs,
} from './lib/service-tunnels.mjs';
import { convergePeerPorts } from './lib/service-peers.mjs';
import { siteRoot } from './lib/paths.mjs';
// THE PROFILE MANIFEST IS OPERATOR CONFIG, SO IT IS RESOLVED THE WAY EVERY
// OTHER MANIFEST IS — see `profilesPath()` below.
import { profileManifestPath } from './lib/node-profiles.mjs';
import { isGuestNode } from '../dist/lib/node-role.js';

const JSON_OUT = process.argv.includes('--json');
const WRITE = process.argv.includes('--write');
/**
 * Converge a GUEST anyway.
 *
 * The default is to skip one, and the skip is the point (see `main`). The flag
 * exists so the operator who decides a guest needs the fleet's toolchain after
 * all has a door that is not "edit the manifest", and it must be typed every
 * time — there is no manifest field that turns it off permanently, because a
 * permanent opt-in is just a guest that is a claw.
 */
const INCLUDE_GUESTS = process.argv.includes('--include-guests');
const ONLY = machineArg(process.argv.slice(2), { valueFlags: ['--out', '--budget-min'] });
/**
 * `--refresh`: the CADENCE (issue #69). Instead of converging the floor, move
 * each node's version-managed tools to the newest release that has cleared the
 * debounce — drain, wait until DRAINED, update, re-probe, undrain, one node at a
 * time. See `scripts/lib/refresh-cycle.mjs`. `--plan` detects and prints the
 * work without draining anything. `--out <file>` also writes the JSON document.
 */
const REFRESH = process.argv.includes('--refresh');
const PLAN = process.argv.includes('--plan');
/** Minutes after which `--refresh` starts no NEW node. Default 90. */
const BUDGET_MIN = (() => {
	const i = process.argv.indexOf('--budget-min');
	const n = i === -1 ? 90 : Number(process.argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? n : 90;
})();
const OUT = (() => {
	const i = process.argv.indexOf('--out');
	return i === -1 ? null : (process.argv[i + 1] ?? null);
})();

const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

// The `REPAIRS` table's documentation left with the table: it is
// `scripts/lib/toolchain-floor.mjs`'s, verbatim, and the copy that stayed here
// after the extraction sat above `onNode` describing something this file no
// longer holds. A comment that names code that is not there is the shape this
// repo has paid for four times; it is deleted rather than moved.

/**
 * Where `node-profiles.json` is, and why it is NOT beside this file.
 *
 * This read `join(__dirname, '..', 'manifests', 'node-profiles.json')` until
 * 2026-09-24, and that path exists in a SOURCE CHECKOUT and nowhere else:
 * `manifests/` is deliberately absent from package.json `files` (it is operator
 * config, not package content — `manifests/README.md` and CLAUDE.md both say
 * so). So from the CLI as it is actually installed —
 * `node_modules/@wolffm/fleet-manager/` — the arithmetic pointed at a directory
 * the package does not ship, and `fleet provision`'s converge step died with
 * `node-profiles.json not found` on every node. Measured against the published
 * 0.24.14 on 2026-09-24: exit 1, before a single node was contacted. Issue #58.
 *
 * `profileManifestPath()` is `scripts/lib/node-profiles.mjs`'s resolver — the
 * SAME one `fleet usb-prep` and `fleet enroll` already use — and it goes
 * through `FLEET_MANIFEST_DIR`, like the fleet manifest, the coverage file and
 * every other operator artifact. It THROWS when the directory is wrong, which
 * is the point: a floor that resolves to nothing reports a perfectly converged
 * fleet of zero requirements.
 *
 * `FLEET_NODE_PROFILES` still wins. It is the one-file override for pointing a
 * run at a profile set that is not the operator's (a stick's copy, a fixture) —
 * it is NOT the way a deployed CLI is expected to find its profiles, and
 * needing it to run the chain at all was the bug.
 */
function profilesPath() {
	return process.env.FLEET_NODE_PROFILES || profileManifestPath();
}

/**
 * Run a snippet on a node as ROLE. Local host runs directly — hokon refuses ssh
 * to itself. The READ is as ci, the user every job runs as, and the INSTALL is
 * as admin, who has sudo: on a cut-over node admin cannot reach ci's tools and
 * has a daemon ci does not, so an admin read was wrong both ways (claw-5,
 * 2026-10-28: jdk21/maven "broken", docker "fine").
 */
function onNode(node, script, { role, timeoutMs = 600_000 }) {
	return runOnSync(node, script, { as: role, timeoutMs, connectTimeout: 8 });
}

/** One read of a node's observed state. Never reports what was WRITTEN. */
function observe(node, packages, repairs) {
	const detects = repairs
		.map(([id, r]) => `printf 'REPAIR %s %s\\n' '${id}' "$(${r.detect} || echo MISSING)"`)
		.join('\n');
	const script = `
		for p in ${packages.join(' ')}; do
			dpkg -s "$p" >/dev/null 2>&1 || printf 'PKG-MISSING %s\\n' "$p"
		done
		${detects}
	`;
	const res = onNode(node, script, { role: 'ci' });
	if (!res.ok) {
		// "I could not look" is a FAILURE, and it says which kind. A node that is
		// unreachable, one whose dpkg is broken and one that timed out are three
		// different jobs, and a bare "drift" would make all three the same ticket.
		return {
			readable: false,
			reason: (res.stderr || res.error || 'unreadable').trim().slice(0, 200),
		};
	}
	const { missingPackages, brokenCapabilities } = parseObservation(res.out ?? '');
	return { readable: true, missingPkgs: missingPackages, brokenCaps: brokenCapabilities };
}

/**
 * Install what the read found missing, as admin. A capability goes through
 * `installScript`, as bootcamp and the refresh cycle do: a version-managed tool
 * (jdk21, maven, claude) installs the debounced release `resolveInstallTarget`
 * names, and a repair that installs FOR the ci user (docker) is told who that
 * is. The raw repair text has neither and died on `TARGET_VERSION: unbound`.
 */
async function converge(node, missingPkgs, brokenCaps, manifest) {
	const steps = [];
	const failed = [];
	if (missingPkgs.length) {
		steps.push(
			`sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends ${missingPkgs.join(' ')}`
		);
	}
	const ciUser = separateCiUser(node, manifest);
	for (const id of brokenCaps) {
		let version;
		if (isVersionManaged(REPAIRS[id])) {
			const resolved = await resolveInstallTarget(REPAIRS[id]);
			if (resolved.status !== 'known') {
				failed.push(
					`${id}: could not determine the debounced release to install: ${resolved.reason}`
				);
				continue;
			}
			version = resolved.version;
		}
		steps.push(installScript(id, version, { ciUser }));
	}
	if (!steps.length) return { ok: !failed.length, reason: failed.join('; ') || null };
	const res = onNode(node, `set -u\nexport DEBIAN_FRONTEND=noninteractive\n${steps.join('\n')}`, {
		role: 'admin',
	});
	const reasons = [...failed];
	if (!res.ok) reasons.push((res.stderr || res.error || 'repair failed').trim().slice(0, 300));
	return { ok: res.ok && !failed.length, reason: reasons.join('; ') || null };
}

/**
 * `--refresh`: the cadence. Exits 1 on ANY finding; `--json` is a contract, so
 * the document is emitted whatever the exit code is.
 */
async function refresh() {
	const manifest = loadManifest();
	const machines = Object.entries(manifest.machines ?? {}).filter(
		([name]) => !name.startsWith('$') && (!ONLY || name === ONLY)
	);
	if (!machines.length) {
		log(`no machines selected${ONLY ? ` (--machine ${ONLY} matched nothing)` : ''}`);
		process.exit(1);
	}
	log(
		PLAN ? 'MODE: --refresh --plan (detect only; nothing is drained or written)' : 'MODE: --refresh'
	);
	log('');
	const deps = createLiveDeps();
	const state = { held: null };
	// A cycle killed mid-node must not leave an outage behind: put back the node
	// WE hold. (A node held on purpose after a failed re-probe clears `held`.)
	for (const sig of ['SIGTERM', 'SIGINT']) {
		process.on(sig, () => {
			if (state.held) {
				const r = deps.undrain(state.held);
				log(`${sig}: ${state.held} ${r.ok ? 'undrained' : `STILL DRAINED (${r.reason})`}`);
			}
			process.exit(1);
		});
	}
	const report = await runRefreshCycle({
		machines,
		deps,
		plan: PLAN,
		log,
		state,
		deadline: Date.now() + BUDGET_MIN * 60_000,
	});

	// EARNED CAPABILITIES COME WITH THEIR ARTIFACTS (#102, wave 4c lane E), run
	// on the SAME nightly cadence this subcommand already carries
	// (`ci:toolchain-refresh`, 12:00Z) — additive to `report`, never replacing
	// a field the JSON contract already promises. `--plan` detects and prints
	// without draining OR writing anything (see the flag's own doc above this
	// function); seeding a cache is itself a write, so it is skipped under
	// `--plan` for the same reason nothing is drained under it.
	if (!PLAN) {
		const seedDeps = defaultSeedDeps();
		const seedResults = [];
		for (const [name, entry] of machines) {
			for (const r of await seedNode(name, entry, manifest, seedDeps)) {
				seedResults.push({ node: name, ...r });
			}
		}
		for (const r of seedResults) {
			if (isSeedFinding(r.status)) {
				report.findings.push({ node: r.node, kind: `seed-${r.status}`, reason: r.reason });
			}
		}
		report.seeds = seedResults;
		report.ok = report.findings.length === 0;
	}

	// EACH SERVICE HOST'S OWN TUNNEL (service-hosts plan P1), on the same
	// nightly cadence. Additive to `report`, like `seeds`. `--plan` checks
	// without creating or writing anything. See scripts/lib/service-tunnels.mjs.
	const tunnelRun = await serviceTunnels(manifest);
	report.tunnels = tunnelRun.tunnels;
	report.peers = tunnelRun.peers;
	report.findings.push(...tunnelRun.findings);
	report.ok = report.findings.length === 0;

	log('');
	for (const f of report.findings) log(`FINDING ${f.node ?? '-'} [${f.kind}] ${f.reason}`);
	for (const r of report.seeds ?? []) {
		if (r.status === 'seeded') {
			log(
				`SEED ${r.node} ${r.id}: ${r.proof} (pin ${r.pin}, ${r.freeMb} MiB free on the cache filesystem)`
			);
		} else if (r.status === 'busy') {
			log(`SEED ${r.node} ${r.id}: skipped — a Runner.Worker is live`);
		}
	}
	log(
		report.ok
			? `Refresh ${PLAN ? 'plan' : 'cycle'} clean (${report.deferred} deferred).`
			: `${report.findings.length} finding(s).`
	);
	if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
	if (JSON_OUT) emitter.emit(report);
	process.exit(report.ok ? 0 : 1);
}

async function serviceTunnels(manifest) {
	let docs;
	try {
		docs = readSiteDocs(siteRoot());
	} catch (err) {
		return {
			tunnels: [],
			findings: [
				{ node: null, kind: 'tunnel-unverified', reason: `the site's placements: ${err.message}` },
			],
			peers: [],
		};
	}
	const hosts = Object.fromEntries(
		Object.entries(docs.hostsDoc.hosts ?? {}).filter(([n]) => !ONLY || n === ONLY)
	);
	const token = process.env[TOKEN_ENV];
	const run = (node, script) => onNode(node, script, { role: 'admin', timeoutMs: 120_000 });
	const tunnelRun = await convergeTunnels({
		manifest,
		hostsDoc: { ...docs.hostsDoc, hosts },
		childApps: docs.childApps,
		token,
		write: !PLAN,
		deps: { cf: cloudflare(token), onNode: run, health: healthStatus },
		log,
	});
	// A hot standby's peer port, closed to all but its pair-mate (lib/service-peers.mjs).
	// Needs no Cloudflare token, so it runs whether or not one was passed.
	const peerRun = await convergePeerPorts({
		childApps: docs.childApps,
		hostsDoc: docs.hostsDoc,
		nodes: Object.keys(hosts).filter((n) => n !== docs.hostsDoc.hub),
		write: !PLAN,
		deps: { onNode: run },
	});
	return {
		tunnels: tunnelRun.tunnels,
		peers: peerRun.peers,
		findings: [...tunnelRun.findings, ...peerRun.findings],
	};
}

async function main() {
	const manifest = loadManifest();
	const machines = Object.keys(manifest.machines ?? {}).filter((m) => !m.startsWith('$'));
	const nodes = ONLY ? machines.filter((m) => m === ONLY) : machines;
	if (!nodes.length) {
		log(`no machines selected${ONLY ? ` (--only ${ONLY} matched nothing)` : ''}`);
		process.exit(1);
	}

	const { common, divergent, profileIds } = declaredPackages(profilesPath());
	const drains = readDrains();
	log(
		`Toolchain floor: ${common.length} packages common to ${profileIds.length} profile(s) ` +
			`(${profileIds.join(', ')})${divergent.length ? `; ${divergent.length} chassis-specific, not converged here` : ''}`
	);
	log(
		`Capabilities beyond apt: ${Object.keys(REPAIRS).join(', ')} ` +
			'(scoped ones apply only to nodes that offer their capability)'
	);
	log(WRITE ? 'MODE: --write (converge, then RE-PROBE)' : 'MODE: check only (--write to converge)');
	log('');

	const results = [];
	let drifted = 0;
	let unreadable = 0;

	let skippedGuests = 0;

	for (const node of nodes) {
		// A GUEST IS NOT CONVERGED, AND THE SKIP IS PRINTED.
		//
		// This is the gate that would apt-get on the production host. hokon runs
		// mgmt-api, the tunnel and the other production services, and the operator's decision of
		// 2026-09-14 is that CI's toolchain is not the fleet's to install there:
		// "hokon is a guest fleet member; they are here when they are needed."
		// `--write` on a guest is the specific damage — an unattended
		// `apt-get install` against the box every other gate in this fleet
		// reports through.
		//
		// It PRINTS, and it rides in `--json`, because a silent skip is how a
		// node stops being checked and nobody notices. This is a node deliberately
		// out of scope, which is a different fact from `ok` and from
		// `expected-down`, and the report says which.
		if (isGuestNode(manifest.machines?.[node]) && !INCLUDE_GUESTS) {
			skippedGuests++;
			log(`── ${node}  [skipped: guest]`);
			log(
				'   A guest lends the fleet a registration and nothing else — convergence, and ' +
					'any repair needing sudo, are out of scope there (operator, 2026-09-14).'
			);
			log('   Override for one run with --include-guests.');
			results.push({ node, status: 'guest', role: 'guest' });
			continue;
		}

		// Read ONCE outside the loop above: a drain landing mid-sweep would judge
		// two nodes in the same run against different state.
		const defer = deferralFor(node, drains);

		const repairs = applicableRepairs(manifest.machines?.[node]);
		let state = observe(node, common, repairs);
		if (!state.readable) {
			// A node a human deliberately powered off is EXPECTED down, not a
			// finding — but it stays in the report, stays visible, and the
			// deferral expires. Everything else is a failure that names its kind:
			// unreachable, broken dpkg and timed out are three different tickets.
			if (defer.deferred) {
				log(`── ${node}  [expected down]`);
				log(`   ${deferralNote(node, defer)}`);
				results.push({ node, status: 'expected-down', reason: state.reason });
				continue;
			}
			unreadable++;
			log(`── ${node}  [UNREADABLE]`);
			log(`   ${state.reason}`);
			log('   Not a pass. A node that cannot be read has not been shown to be converged.');
			results.push({ node, status: 'unreadable', reason: state.reason });
			continue;
		}

		let { missingPkgs, brokenCaps } = state;
		let repair = null;
		if (WRITE && (missingPkgs.length || brokenCaps.length)) {
			repair = await converge(node, missingPkgs, brokenCaps, manifest);
			// RE-PROBE. The install's exit code is the writer describing itself.
			state = observe(node, common, repairs);
			if (!state.readable) {
				unreadable++;
				log(`── ${node}  [UNREADABLE AFTER REPAIR]`);
				log(`   ${state.reason}`);
				results.push({ node, status: 'unreadable', reason: state.reason });
				continue;
			}
			({ missingPkgs, brokenCaps } = state);
		}

		const clean = !missingPkgs.length && !brokenCaps.length;
		if (clean) {
			log(`── ${node}  [ok]${repair ? '  (converged)' : ''}`);
		} else {
			drifted++;
			log(`── ${node}  [${WRITE ? 'STILL DRIFTED' : 'drift'}]`);
			if (missingPkgs.length) log(`   packages missing: ${missingPkgs.join(' ')}`);
			for (const id of brokenCaps) log(`   capability "${id}": ${REPAIRS[id].why}`);
			if (repair && !repair.ok) log(`   repair failed: ${repair.reason}`);
			if (!WRITE) log('   fix: fleet converge-toolchain --write');
		}
		results.push({
			node,
			status: clean ? 'ok' : 'drift',
			missingPackages: missingPkgs,
			brokenCapabilities: brokenCaps,
			converged: Boolean(repair?.ok),
		});
	}

	log('');
	// ZERO NODES ACTUALLY LOOKED AT IS NOT A PASS, even when every skip was
	// deliberate. `--machine hokon` selects one guest, skips it, and would
	// otherwise exit 0 having converged nothing — "I could not look" wearing
	// "I chose not to look" as a costume. The unqualified sweep never hits this:
	// it always carries claws.
	if (skippedGuests === nodes.length) {
		log(
			`Every selected node (${nodes.join(', ')}) is a guest, so nothing was checked. ` +
				'That is not a pass — re-run against a claw, or pass --include-guests if you ' +
				'really mean to converge a guest.'
		);
		if (JSON_OUT) {
			emitter.emit({ ok: false, write: WRITE, nodes: results, guestsSkipped: skippedGuests });
		}
		process.exit(1);
	}
	const bad = drifted + unreadable;
	const guestNote = skippedGuests ? `, ${skippedGuests} guest(s) skipped` : '';
	log(
		bad === 0
			? `Every CLAW carries the declared toolchain. (${results.filter((r) => r.status === 'expected-down').length} expected down${guestNote})`
			: `${drifted} node(s) drifted, ${unreadable} unreadable${guestNote}.`
	);
	// Only in --json mode: `emit` is the single stdout write and its payload is a
	// machine's document. Emitting it unasked would put a JSON blob under the
	// human report, which is the same unparseable stream one layer down.
	if (JSON_OUT) {
		emitter.emit({ ok: bad === 0, write: WRITE, nodes: results, guestsSkipped: skippedGuests });
	}
	process.exit(bad === 0 ? 0 : 1);
}

if (REFRESH) await refresh();
else await main();
