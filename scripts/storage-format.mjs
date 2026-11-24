#!/usr/bin/env node
/**
 * fleet storage-format — the format + mount converger (storage bootcamp F5,
 * hadoku-fleet-manager#140). THE RULES ARE IN lib/storage-format.mjs.
 *
 *   fleet storage-format                               every node: what it would do to each candidate disk
 *   fleet storage-format --machine claw-9              one node, the exact script per disk
 *   fleet storage-format --machine claw-9 --disk <serial> --confirm
 *                                                      format, fstab and mount THAT disk, under the idle hold
 *     [--wipe-signature]                               also destroy an existing partition table/filesystem
 *     [--fs=xfs]                                       xfs instead of ext4
 *     [--json]
 *
 * Without `--confirm` nothing is drained and nothing but the read-only probe
 * (storage-probe.sh, as the admin role, no sudo) runs on a node. `--confirm`
 * needs `--machine` AND `--disk`: there is no fleet-wide or every-disk write.
 *
 * EXIT: 0 dry run, formatted or already converged; 1 failed or could not look;
 * 2 refused or bad arguments.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../dist/lib/fleet-paths.js';
import { drain, busyCount, isDrained, undrain, waitUntilDrained } from './lib/drain-wait.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { loadManifest, machineArg, runOn } from './lib/fleet-exec.mjs';
import { readQualifyResults } from './lib/qualify-results.mjs';
import { parseStorage } from './lib/storage-inventory.mjs';
import { convergeNode, idleHold, rootWrapped } from './lib/storage-format.mjs';

const argv = process.argv.slice(2);
const parsed = parseStrict(ARGV_SPECS['storage-format.mjs'], argv);
const emitter = createEmitter({ argv: process.argv });
const log = (...m) => emitter.log(...m);
const finish = (doc, code) => {
	if (emitter.json) emitter.emit(doc);
	process.exit(code);
};

const only = machineArg(argv, { valueFlags: ['--disk', '--fs'] });
const disk = parsed.value('--disk');
const confirm = parsed.has('--confirm');
const wipeSignature = parsed.has('--wipe-signature');
const fs = parsed.value('--fs') ?? 'ext4';
if (confirm && (!only || !disk)) {
	log(
		'fleet storage-format: --confirm needs --machine <node> and --disk <serial>; nothing was done'
	);
	finish({ ok: false, error: '--confirm needs --machine and --disk' }, 2);
}

const manifest = loadManifest();
const nodes = only ? [only] : Object.keys(manifest.machines ?? {});
if (only && !manifest.machines?.[only])
	finish({ ok: false, error: `${only} is not in the manifest` }, 2);

const PROBE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), 'storage-probe.sh'),
	'utf8'
);
const holdState = { held: null };
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.once(sig, () => {
		if (holdState.held) undrain(holdState.held);
		process.exit(sig === 'SIGINT' ? 130 : 143);
	});
}

const hold = idleHold({
	isDrained,
	drain,
	undrain,
	waitQuiet: (n) =>
		waitUntilDrained({
			node: n,
			busy: busyCount,
			clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
		}),
});

const deps = {
	readInventory: async (node) => {
		const r = await runOn(node, `${PROBE}\nstorage_probe`, { as: 'admin', manifest });
		if (!r.ok) {
			// A node drained for maintenance is said as such (expected-down-guard).
			const d = deferralFor(node, readDrains());
			const why = `probe failed: ${r.error ?? r.stderr.trim()}`;
			return { ok: false, reason: d.deferred ? `${why} (${d.why})` : why };
		}
		try {
			return { ok: true, inventory: parseStorage(r.stdout) };
		} catch (e) {
			return { ok: false, reason: `probe output unreadable: ${e.message}` };
		}
	},
	readLedger: () => readQualifyResults(stateDir()),
	hold: (node, reason, act) => {
		holdState.held = node;
		return hold(node, reason, act).finally(() => (holdState.held = null));
	},
	runRoot: (node, script) =>
		runOn(node, rootWrapped(script), { as: 'admin', manifest, timeoutMs: 30 * 60_000 }),
};

const out = [];
for (const node of nodes) {
	const r = await convergeNode({ node, disk, confirm, fs, wipeSignature, deps });
	out.push(r);
	log(`== ${node}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
	for (const d of r.disks) {
		log(`  ${d.serial ?? '(no serial)'} ${d.device} ${d.model ?? ''}: ${d.verdict}`);
		for (const why of d.reasons) log(`    - ${why}`);
		if (d.script && !confirm) log(rootWrapped(d.script).replace(/^/gm, '    | '));
	}
	if (r.undrainFailed) log(`  !! ${node} is STILL DRAINED: undrain failed: ${r.undrainFailed}`);
}

const bad = out.filter((r) => ['failed', 'could-not-look'].includes(r.status) || r.undrainFailed);
const refused = out.some((r) => r.status === 'refused');
finish({ ok: !bad.length && !refused, confirm, nodes: out }, bad.length ? 1 : refused ? 2 : 0);
