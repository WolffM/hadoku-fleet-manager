#!/usr/bin/env node
/**
 * fleet storage-pool — the `ci:storage-pool` gate (hadoku-fleet-manager#142).
 *
 * Reads the Garage pool live, through the first member whose admin API
 * answers (garage-admin.mjs's `readPool`, the doctor's own reader), and judges
 * it with `storage-pool-gate.mjs` over F3's findings. What pages, what warns
 * and what is a known state is that module's header.
 *
 * `--json` is under the contract (`ci:storage-pool`): one GateDoc-shaped
 * document, `ok` false on a finding that pages or anything unreadable, plus
 * `warnings` and `known`, which never fail it. Exit 1 when not ok.
 *
 * No node offers `storage`: "no pool", exit 0. Nothing is read or written.
 *
 * Writes `<stateDir>/storage-pool.json` (`underReplicatedSince`) on every run
 * that read the pool: the 24 h clock lives on the controller, so the job is
 * host-bound.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { parseStrict } from './lib/argv.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { loadManifest, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { readPool } from './lib/garage-admin.mjs';
import { toolAppliesTo } from './lib/toolchain-floor.mjs';
import { judgePool } from './lib/storage-pool-gate.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { writeJsonAtomicSync } from '../dist/lib/atomic-json.js';

parseStrict(ARGV_SPECS['storage-pool.mjs'], process.argv.slice(2));
const emitter = createEmitter({ argv: process.argv });
const now = new Date();

const members = selectMachines(loadManifest(), {})
	.filter(([, m]) => toolAppliesTo('garage', m))
	.map(([name]) => name);

const recordPath = join(stateDir(), 'storage-pool.json');
const prior = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;

const input = members.length
	? {
			members,
			...(await readPool(
				members,
				(node) => (script) => runOn(node, script, { as: 'admin', timeoutMs: 30_000 }),
				now.toISOString()
			)),
		}
	: { members, garage: null, why: null };

// A drain file that cannot be read is its own "could not look", never "nothing
// is drained" (expected-down.mjs): it fails the run with that reason.
const deferred = new Map();
let drainError = null;
if (input.garage === null && members.length) {
	try {
		const drains = readDrains(now.getTime());
		for (const m of members) {
			const d = deferralFor(m, drains, now.getTime());
			if (d.deferred) deferred.set(m, deferralNote(m, d));
		}
	} catch (e) {
		drainError = e instanceof Error ? e.message : String(e);
	}
}

const judged = judgePool(input, prior, now, deferred);
const verdict = drainError
	? {
			...judged,
			ok: false,
			unreadable: [
				...judged.unreadable,
				{ node: null, why: `fleet-drain.json unreadable: ${drainError}` },
			],
			why: [judged.why, `fleet-drain.json unreadable: ${drainError}`].filter(Boolean).join('; '),
		}
	: judged;
if (verdict.state === 'read') writeJsonAtomicSync(recordPath, verdict.record, { space: 2 });

emitter.log(verdict.summary);
for (const [label, list] of [
	['PAGE', verdict.findings],
	['warn', verdict.warnings],
	['known', verdict.known],
]) {
	for (const f of list) emitter.log(`  ${label}  ${f.node}  ${f.kind}: ${f.reason}`);
}
for (const u of verdict.unreadable) emitter.log(`  UNREADABLE  ${u.node}: ${u.why}`);
if (emitter.json) emitter.emit({ ...verdict, via: input.via ?? null });
process.exit(verdict.ok ? 0 : 1);
