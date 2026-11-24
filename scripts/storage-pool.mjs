#!/usr/bin/env node
/**
 * fleet storage-pool — the `ci:storage-pool` gate (hadoku-fleet-manager#142).
 *
 * Reads the Garage pool live, through the first member whose admin API
 * answers (garage-admin.mjs's `readPool`, the doctor's own reader), then every
 * member's own view of who is up (`readMemberViews`, #154: a split only the
 * other members see), and judges both with `storage-pool-gate.mjs`. What
 * pages, what warns and what is a known state is that module's header.
 *
 * `--json` is under the contract (`ci:storage-pool`): one GateDoc-shaped
 * document, `ok` false on a finding that pages or anything unreadable, plus
 * `warnings` and `known`, which never fail it. Exit 1 when not ok.
 *
 * Members are the zones garage-layout.json declares (garage-layout-declared.mjs,
 * #153). None declared: "no pool", exit 0, nothing read or written. A
 * declaration that cannot be read fails, as anything else unread does.
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
import { runOn } from './lib/fleet-exec.mjs';
import { declaredMembers } from './lib/garage-layout-declared.mjs';
import { nodeAdmin, readMemberViews, readPool, seenBy } from './lib/garage-admin.mjs';
import { judgePool } from './lib/storage-pool-gate.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { writeJsonAtomicSync } from '../dist/lib/atomic-json.js';

parseStrict(ARGV_SPECS['storage-pool.mjs'], process.argv.slice(2));
const emitter = createEmitter({ argv: process.argv });
const now = new Date();

const { nodes: members, error: membersWhy } = declaredMembers();

const recordPath = join(stateDir(), 'storage-pool.json');
const prior = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;

const execFor = (node) => (script) => runOn(node, script, { as: 'admin', timeoutMs: 30_000 });
// 120 s: the quarantine count walks every block file of a data dir.
const countFor = (node) => (script) => runOn(node, script, { as: 'admin', timeoutMs: 120_000 });
const input = members.length
	? {
			members,
			...(await readPool(members, execFor, now.toISOString())),
			views: await readMemberViews(members, (node) => nodeAdmin(node, execFor(node)), countFor),
		}
	: { members, membersWhy, garage: null, why: null, views: [] };

// A drain file that cannot be read is its own "could not look", never "nothing
// is drained" (expected-down.mjs): it fails the run with that reason.
const deferred = new Map();
let drainError = null;
const viewsOff = input.views.some(
	(v) =>
		!v.status || v.corrupted === null || Object.values(seenBy(v.status)).some((s) => s !== 'up')
);
if (members.length && (input.garage === null || viewsOff)) {
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
for (const v of verdict.views) {
	const sees = v.read
		? Object.entries(v.sees)
				.map(([n, s]) => `${n}=${s}`)
				.join(' ')
		: `unread: ${v.why}`;
	const disks = v.corrupted
		? v.corrupted.map((d) => `${d.disk}:${d.count} corrupted`).join(' ')
		: `corrupted unread: ${v.corruptedWhy ?? 'not counted'}`;
	emitter.log(
		`  view  ${v.node}: ${v.health ?? ''} ${sees}; ${disks}; resync errors ${v.resyncErrors ?? '?'}`
	);
}
if (emitter.json) emitter.emit({ ...verdict, via: input.via ?? null });
process.exit(verdict.ok ? 0 : 1);
