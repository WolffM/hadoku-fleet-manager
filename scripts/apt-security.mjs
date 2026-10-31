#!/usr/bin/env node
/**
 * apt-security — will each node actually install Debian security updates, and
 * (with --confirm) make it so.
 *
 *   fleet apt-security                       # check every node
 *   fleet apt-security --machine claw-4      # one claw
 *   fleet apt-security --confirm             # repair the nodes that drifted
 *   fleet apt-security --json                # one document
 *
 * WHY. Until 2026-10-25 every claw's unattended-upgrades origin pattern matched
 * nothing (lib/apt-security.mjs has the measurement), and nothing noticed,
 * because nothing ever RAN the policy. The check here does: it executes
 * `unattended-upgrade --dry-run -d` and judges what that resolves and selects.
 *
 * WHO RUNS IT. The provisioning converger (`fleet converge-provisioning`, on
 * the controller's own timer) runs `--check`, then `--confirm --machine N` on
 * each node that drifted, then `--check --machine N` again, and pages only if
 * the re-check still disagrees. The repair writes two apt conf files and
 * enables two timers; it restarts nothing and touches no runner, so unlike the
 * throttle and slice facets it never waits for a node to go idle.
 *
 * THE BACKSTOP IS READ AND NEVER WRITTEN. The fleet has no sudo there, so its
 * dry run may not even answer, and its repair is the operator's: every finding
 * on it is an ADVISORY naming the hand-run (`--operator-sudo`, see
 * lib/operator-sudo.mjs), and none of them fails the run.
 *
 * EXIT 0 only when every node was read and (in --check) none drifted, or (in
 * --confirm) every repair ran. `--json` is parseable either way.
 */
import process from 'node:process';

import {
	aptSecurityPolicy,
	judgeProbe,
	parseProbe,
	probeScript,
	repairScript,
	summaryOf,
} from './lib/apt-security.mjs';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { loadManifest, machineArg, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { loadNodeProfiles } from './lib/node-profiles.mjs';
import { maySudo, rootAdvisory } from './lib/operator-sudo.mjs';

const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const ONLY = machineArg(argv);
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

/** The dry run is ~5s on an idle claw; under a build it is the CPU that is slow, not apt. */
const PROBE_TIMEOUT_MS = 120_000;

const unreachable = (res) => res.error ?? (res.stderr.trim() || 'unreachable');

async function checkNode(node, drains) {
	const res = await runOn(node, probeScript(), {
		as: 'admin',
		timeoutMs: PROBE_TIMEOUT_MS,
		connectTimeout: 8,
	});
	const parsed = res.ok ? parseProbe(res.stdout) : { ok: false, error: unreachable(res) };
	if (!parsed.ok) {
		const defer = deferralFor(node, drains);
		return { machine: node, ok: false, error: parsed.error, expectedDown: defer.deferred };
	}
	const drift = judgeProbe(parsed);
	return {
		machine: node,
		ok: true,
		summary: summaryOf(parsed, drift),
		notes: drift.map((d) => `DRIFT ${d}`),
		drift,
		probe: parsed,
	};
}

async function main() {
	const manifest = loadManifest();
	const nodes = selectMachines(manifest, { only: ONLY });
	if (!nodes.length) {
		const error = ONLY
			? `--machine ${ONLY} selected no node`
			: 'the manifest selects no node; zero nodes checked is not a pass';
		log(error);
		if (emitter.json) emitter.emit({ ok: false, error, results: [] });
		process.exitCode = 1;
		return;
	}
	// The policy is read before anything is written, and a profile set with no
	// single answer refuses the whole run rather than one node at a time.
	const policy = CONFIRM ? aptSecurityPolicy(loadNodeProfiles().profiles) : null;
	const drains = readDrains();
	const results = await Promise.all(nodes.map(([node]) => checkNode(node, drains)));
	// Root work on a node the fleet has no sudo on: read, judged, never written.
	for (const r of results) {
		if (maySudo(manifest.machines?.[r.machine]) || r.expectedDown) continue;
		r.advisory = true;
		if (!r.ok || r.drift.length) {
			r.advisories = [
				rootAdvisory(
					r.machine,
					r.ok
						? `the security-update policy (${r.drift.join('; ')})`
						: `reading the security-update policy (${r.error})`,
					`fleet apt-security --machine ${r.machine} --confirm`
				),
			];
		}
	}

	if (CONFIRM) {
		for (const r of results) {
			if (!r.ok || !r.drift.length || r.advisory) continue;
			const res = await runOn(r.machine, repairScript(policy), {
				as: 'admin',
				timeoutMs: 60_000,
				connectTimeout: 8,
			});
			if (res.ok && res.stdout.includes('REPAIRED')) {
				r.summary = `${r.summary} changed=1`;
				r.notes.push(
					'REPAIRED wrote 20auto-upgrades and 50unattended-upgrades, enabled the apt timers'
				);
			} else {
				r.ok = false;
				r.error = `repair failed: ${unreachable(res)}`;
			}
		}
	}

	for (const r of results) {
		if (r.advisories) {
			for (const a of r.advisories) log(`── ${r.machine}  [advisory] ${a.message}\n   ${a.fix}`);
			continue;
		}
		if (!r.ok) {
			log(`── ${r.machine}  [${r.expectedDown ? 'expected down' : 'UNREADABLE'}] ${r.error}`);
			continue;
		}
		log(
			`── ${r.machine}  [${r.drift.length ? (CONFIRM ? 'repaired' : 'DRIFT') : 'ok'}] ${r.summary}`
		);
		for (const n of r.notes) log(`   ${n}`);
	}

	const unread = results.filter((r) => !r.ok && !r.expectedDown && !r.advisory);
	const drifted = results.filter((r) => r.ok && r.drift.length && !r.advisory);
	const ok = unread.length === 0 && (CONFIRM || drifted.length === 0);
	if (!drifted.length && !unread.length) log('✓ every node will install Debian security updates.');
	if (emitter.json) emitter.emit({ ok, mode: CONFIRM ? 'confirm' : 'check', results });
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`apt-security: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
