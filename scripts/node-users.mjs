#!/usr/bin/env node
/**
 * fleet node-users — who runs CI on each node, read from the node.
 *
 *   fleet node-users            # every claw
 *   fleet node-users --machine claw-5
 *   fleet node-users --json
 *   fleet node-users --cutover claw-5 [--confirm]   # see node-users-cutover.mjs
 *
 * The facet and its rules are `lib/node-users-facet.mjs`; the concept is
 * `src/lib/node-users.ts`. Without `--cutover` it only checks; the cutover
 * (`node-users-cutover.mjs`, docs/planning/node-users-2026-10-27.md P3) is what
 * creates and moves a ci user, and this reads the result.
 *
 * EXIT 0 only when every node answered and none that HAS been cut over has
 * drifted. A node still running CI as admin is reported, with what that means,
 * but it is the state the plan is moving away from, not a failure of this run.
 */
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { loadManifest, machineArg, runOn, selectNodes } from './lib/fleet-exec.mjs';
import {
	judgeNodeUsers,
	parseUsersObservation,
	usersObserveScript,
} from './lib/node-users-facet.mjs';

const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

async function checkNode(node, machine, drains) {
	const res = await runOn(node, usersObserveScript(machine), {
		as: 'admin',
		timeoutMs: 30_000,
		connectTimeout: 8,
	});
	const obs = parseUsersObservation(res.stdout);
	if (!obs) {
		const why = res.error ?? (res.stderr.trim() || 'the node did not finish answering');
		return {
			machine: node,
			ok: false,
			error: why,
			expectedDown: deferralFor(node, drains).deferred,
		};
	}
	return { machine: node, ok: true, ...judgeNodeUsers(machine, obs), observed: obs };
}

async function main() {
	const ONLY = machineArg(process.argv.slice(2));
	const manifest = loadManifest();
	const { nodes, skippedByRole } = selectNodes(manifest, { only: ONLY });
	for (const s of skippedByRole) log(`── ${s.node}  [skipped: ${s.role}] ${s.why}`);
	if (!nodes.length) {
		const error = ONLY
			? `--machine ${ONLY} selected no claw`
			: 'the manifest selects no claw; zero nodes checked is not a pass';
		log(error);
		if (emitter.json) emitter.emit({ ok: false, error, results: [], skippedByRole });
		process.exitCode = 1;
		return;
	}
	const drains = readDrains();
	const results = await Promise.all(nodes.map(([n, m]) => checkNode(n, m, drains)));
	for (const r of results) {
		if (!r.ok) {
			log(`── ${r.machine}  [${r.expectedDown ? 'expected down' : 'UNREADABLE'}] ${r.error}`);
			continue;
		}
		log(`── ${r.machine}  [${r.state}]`);
		for (const f of r.findings) log(`   ${f.class.padEnd(9)} ${f.category}: ${f.why}`);
	}
	const unread = results.filter((r) => !r.ok && !r.expectedDown);
	const drifted = results.filter((r) => r.ok && r.state !== 'ok' && r.state !== 'not-cut-over');
	const pending = results.filter((r) => r.state === 'not-cut-over').length;
	const ok = !unread.length && !drifted.length;
	log(
		`${results.length} node(s): ${results.length - pending - unread.length} cut over, ${pending} still running CI as admin` +
			(drifted.length ? `, ${drifted.length} DRIFTED` : '')
	);
	if (emitter.json) emitter.emit({ ok, results, skippedByRole });
	process.exitCode = ok ? 0 : 1;
}

if (process.argv.includes('--cutover')) {
	await import('./node-users-cutover.mjs');
} else {
	main().catch((err) => {
		console.error(`node-users: ${err instanceof Error ? err.stack : String(err)}`);
		process.exit(1);
	});
}
