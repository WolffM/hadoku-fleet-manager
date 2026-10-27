#!/usr/bin/env node
/**
 * reboot-claws — reboot at most ONE claw that needs it: drain, wait until it
 * is idle, reboot, verify it came back on the new kernel with its runners and
 * services, undrain. lib/reboot-cycle.mjs is the whole policy; this is its
 * live dependencies.
 *
 *   fleet reboot-claws --plan              # what would be rebooted, and why; touches nothing
 *   fleet reboot-claws                     # one pass
 *   fleet reboot-claws --machine claw-3    # one pass, only that claw
 *   fleet reboot-claws --json              # the pass as one document
 *
 * WHO RUNS IT. The controller, on its own timer (src/claw-reboot.ts), which
 * pages on a node that failed verification. A pass that finds nothing to do
 * costs one ssh per claw.
 *
 * STATE ON DISK: `<stateDir>/claw-reboot.json` — the reboot in flight, if any,
 * and when each claw was last rebooted. A pass killed between the reboot and
 * its verification leaves the record, and the next pass finishes the job.
 * Killed while still waiting for the node to go idle, it puts the node back.
 *
 * EXIT 0 when the pass raised no finding. `--json` is parseable either way.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { isLocalNode } from '../dist/lib/node-identity.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrainDoc, readDrains } from './lib/expected-down.mjs';
import { loadManifest, machineArg, runOnSync } from './lib/fleet-exec.mjs';
import { stateDir } from './lib/paths.mjs';
import { HOSTING_NOTICE_MS } from '../dist/runners/drain.js';
import { hostingOn, readHostingDoc } from '../dist/runners/hosting-record.js';
import {
	REBOOT_PROBE,
	oursOn,
	parseRebootProbe,
	judgeReprove,
	rebootDrainArgs,
	rebootNoticeArgs,
	runRebootCycle,
} from './lib/reboot-cycle.mjs';
import { busyCount, drainCli, liveQueuePressure, waitUntilDrained } from './lib/refresh-cycle.mjs';

const argv = process.argv.slice(2);

// THIS COMMAND'S DEFAULT IS A REAL REBOOT, so a flag it does not know must never
// fall through to one. fleet-exec allows unknown flags fleet-wide on purpose;
// that is safe for a read and not for this. On 2026-10-25 `fleet reboot-claws
// --help` ran a live pass and rebooted claw-4, taking pygmalion down with it.
// Checked before anything is read or probed.
const USAGE =
	'fleet reboot-claws [--plan] [--machine <claw>] [--force] [--json]\n' +
	'  --plan     what would be rebooted, and why; touches nothing\n' +
	"  --force    skip the notice a hosting node's tenant is owed\n" +
	'  (no flag)  one REAL pass: drain one claw, reboot it, verify, undrain';
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
const unknown = argv.filter(
	(a, i) =>
		a.startsWith('-') &&
		!['--plan', '--json', '--machine', '--force'].includes(a) &&
		argv[i - 1] !== '--machine'
);
if (unknown.length) {
	console.error(`✗ unknown flag(s): ${unknown.join(' ')} — nothing was touched.\n${USAGE}`);
	process.exit(2);
}

const PLAN = argv.includes('--plan');
const FORCE = argv.includes('--force');
const ONLY = machineArg(argv);
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

const STATE = () => join(stateDir(), 'claw-reboot.json');
function readState() {
	if (!existsSync(STATE())) return null;
	// Unparseable THROWS: a lost in-flight record is a node left drained or
	// unverified, and starting fresh over it would hide that.
	return JSON.parse(readFileSync(STATE(), 'utf8'));
}
function writeState(s) {
	mkdirSync(dirname(STATE()), { recursive: true });
	writeFileSync(`${STATE()}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
	renameSync(`${STATE()}.tmp`, STATE());
}

const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const deps = {
	isGuest: (entry) => isGuestNode(entry),
	isLocal: (node) => isLocalNode(node),
	probe: (node) => {
		const res = runOnSync(node, REBOOT_PROBE, {
			as: 'admin',
			timeoutMs: 30_000,
			connectTimeout: 6,
		});
		if (!res.ok) return { ok: false, reason: res.error || 'unreachable' };
		return parseRebootProbe(res.stdout);
	},
	expectedDown: (node) => deferralFor(node, readDrains()).deferred,
	drainDoc: () => readDrainDoc(),
	drain: (node, reason, { force = false } = {}) =>
		drainCli([...rebootDrainArgs(node, reason), ...(force ? ['--force'] : [])]),
	// A tenant on the node: the reboot drain is PLANNED, `noticeMin` out, so
	// `fleet drain` (and node-status) carry it as a notice from now.
	announce: (node, reason, noticeMin) => drainCli(rebootNoticeArgs(node, reason, noticeMin)),
	noticeMs: HOSTING_NOTICE_MS,
	hostingOn: (node) => hostingOn(node, readDrainDoc(), readHostingDoc(stateDir()), Date.now()),
	// --force: the node has ALREADY rebooted and failed, so a hosting node's
	// notice cannot apply to holding it, and a broken box is held regardless.
	hold: (node, reason) => drainCli([node, '--kind', 'maintenance', '--reason', reason, '--force']),
	undrain: (node) => drainCli([node, '--undo']),
	waitDrained: (node) => waitUntilDrained({ node, busy: busyCount, clock }),
	queuePressure: () => liveQueuePressure(),
	// Detached on the node, so the ssh returns before the box goes down.
	reboot: (node) => {
		const res = runOnSync(
			node,
			'nohup sh -c "sleep 2; sudo -n systemctl reboot" >/dev/null 2>&1 &\necho SCHEDULED\n',
			{ as: 'admin', timeoutMs: 20_000, connectTimeout: 6 }
		);
		return res.ok && res.stdout.includes('SCHEDULED')
			? { ok: true }
			: { ok: false, reason: res.error || 'reboot was not scheduled' };
	},
	// The capability check, EXECUTING each declared capability on the node,
	// against this node only. Before undrain; see the cycle's re-prove step.
	reprove: (node) => {
		const r = spawnSync(
			process.execPath,
			[
				join(dirname(fileURLToPath(import.meta.url)), 'check-capabilities.mjs'),
				'--machine',
				node,
				'--json',
			],
			{ encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, FLEET_NO_BANNER: '1' } }
		);
		if (r.error)
			return { ok: false, reason: `could not run the capability check: ${r.error.message}` };
		return judgeReprove(node, r.status, r.stdout);
	},
	sleep: clock.sleep,
	now: clock.now,
	readState,
	writeState,
};

// A pass killed while it holds a node it has NOT rebooted puts it back. One
// killed after the reboot leaves the record for the next pass to verify.
for (const sig of ['SIGTERM', 'SIGINT']) {
	process.on(sig, () => {
		const f = readState()?.inFlight;
		if (f?.phase === 'draining' || f?.phase === 'notice') {
			if (oursOn(readDrainDoc(), f.node)) {
				const r = deps.undrain(f.node);
				log(`${sig}: ${f.node} ${r.ok ? 'undrained' : `STILL DRAINED (${r.reason})`}`);
			}
			writeState({ ...readState(), inFlight: null });
		}
		process.exit(1);
	});
}

async function main() {
	const manifest = loadManifest();
	const machines = Object.entries(manifest.machines ?? {}).filter(([n]) => !n.startsWith('$'));
	if (ONLY && !machines.some(([n]) => n === ONLY)) {
		const error = `--machine ${ONLY} is not in the manifest`;
		log(error);
		if (emitter.json) emitter.emit({ ok: false, error, nodes: [], findings: [] });
		process.exitCode = 1;
		return;
	}
	log(
		PLAN ? 'MODE: --plan (probe and pick only; nothing is drained or rebooted)' : 'MODE: one pass'
	);
	const report = await runRebootCycle({
		machines,
		deps,
		plan: PLAN,
		only: ONLY,
		force: FORCE,
		log,
	});
	for (const f of report.findings) log(`FINDING ${f.node ?? '-'} [${f.kind}] ${f.reason}`);
	if (!report.rebooted.length && !report.findings.length) {
		log(PLAN ? 'Plan clean.' : 'Nothing rebooted this pass.');
	}
	if (emitter.json) emitter.emit(report);
	process.exitCode = report.ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`reboot-claws: ${err instanceof Error ? err.stack : String(err)}`);
	if (emitter.json) emitter.emit({ ok: false, error: errorText(err), nodes: [], findings: [] });
	process.exit(1);
});

function errorText(err) {
	return err instanceof Error ? err.message : String(err);
}
