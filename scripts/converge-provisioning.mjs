#!/usr/bin/env node
/**
 * converge-provisioning.mjs — repair standing-runner throttle env and slice
 * placement wherever it has drifted, then read the node again (fleet-manager#1).
 *
 *   fleet converge-provisioning            # check, repair what drifted, re-check
 *   fleet converge-provisioning --json     # the same, as one document
 *   fleet converge-provisioning --dry-run  # check and plan only; nothing is written
 *
 * WHO RUNS IT. fleet-manager's own controller loop, every
 * PROVISIONING_CONVERGE_MS (src/provisioning-converge.ts), which logs what it
 * changed and pages only on what it could not converge. hadoku_site's nightly
 * check:throttle / check:slice stay as the backstop, and should find nothing.
 *
 * HOW. The operator's own drivers, nothing re-derived — see
 * lib/run-fleet-script.mjs for why. One fleet-wide `--check` of each, then for
 * each (node, facet) with drift: `throttle --machine N --confirm` or
 * `slice --machine N --confirm --restart` (see ONE RESTART PER UNIT below),
 * and then a fresh `--check --machine N` of each.
 * Both repairs touch IDLE runners only; a runner mid-job is left running and
 * reported `deferred`. lib/provisioning-converge.mjs decides what drifted and
 * what each repair achieved.
 *
 * WHAT THE REPAIR ALSO DOES. `throttle --confirm` redeploys the node's hook,
 * conf and node-side scripts as well as the `.env`. They are byte-identical
 * unless this package was upgraded since the last deploy, and in that case
 * the deploy is overdue anyway.
 *
 * EXIT 0 only when every drifted facet converged or is deferred behind a live
 * job and every node could be read. `--json` is parseable either way.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmitter } from './lib/emit.mjs';
import { classifyRepair, planRepairs } from './lib/provisioning-converge.mjs';
import { runFleetScript } from './lib/run-fleet-script.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THROTTLE = resolve(__dirname, 'deploy-ci-throttle.mjs');
const SLICE = resolve(__dirname, 'deploy-runners-slice.mjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const emitter = createEmitter({ argv: process.argv });
const log = (...a) => emitter.log(...a);

/** The per-machine result in one driver run, or a could-not-look stand-in. */
function resultFor(run, node) {
	return (
		run.json?.results?.find((r) => r.machine === node) ?? {
			machine: node,
			ok: false,
			error: run.why || 'the driver returned no result for this node',
		}
	);
}

async function main() {
	const [thr, sl] = await Promise.all([
		runFleetScript(THROTTLE, ['--check', '--json']),
		runFleetScript(SLICE, ['--check', '--json']),
	]);
	const unreadable = [];
	if (!thr.json) unreadable.push({ node: '*', facet: 'throttle', why: thr.why });
	if (!sl.json) unreadable.push({ node: '*', facet: 'slice', why: sl.why });
	const plan = planRepairs(thr.json, sl.json);
	unreadable.push(...plan.unreadable);

	const changed = [];
	const deferred = [];
	const unconverged = [];
	const converged = [];

	// ONE RESTART PER UNIT. When a node drifts on both facets — the 10-23 shape —
	// the env is written with `--no-restart` first and the slice restart then
	// loads it, so an idle unit restarts once rather than once per facet. Both
	// facets are re-read only after both repairs, because a restart from either
	// one can settle the other.
	// One node at a time: a pass is rare and seldom has more than one to fix.
	const byNode = new Map();
	for (const item of DRY_RUN ? [] : plan.repair) {
		byNode.set(item.node, { ...byNode.get(item.node), [item.facet]: item });
	}
	for (const [node, facets] of byNode) {
		const confirms = {};
		const throttleConfirm = async (extra) =>
			resultFor(
				await runFleetScript(THROTTLE, ['--machine', node, '--confirm', ...extra, '--json']),
				node
			);
		confirms.throttle = [];
		if (facets.throttle && facets.slice)
			confirms.throttle.push(await throttleConfirm(['--no-restart']));
		if (facets.slice) {
			confirms.slice = resultFor(
				await runFleetScript(SLICE, ['--machine', node, '--confirm', '--restart', '--json']),
				node
			);
		}
		// Throttle alone restarts its own idle runners. After a slice restart it
		// runs again: a runner the slice repair did not touch may still be stale,
		// and one it did restart now reads as wired and is left alone.
		if (facets.throttle) confirms.throttle.push(await throttleConfirm([]));
		for (const facet of ['throttle', 'slice']) {
			const item = facets[facet];
			if (!item) continue;
			const recheck = resultFor(
				await runFleetScript(facet === 'throttle' ? THROTTLE : SLICE, [
					'--machine',
					node,
					'--check',
					'--json',
				]),
				node
			);
			const verdict = classifyRepair(facet, confirms[facet], recheck);
			const row = { node, facet, before: item.before, ...verdict };
			if (verdict.changed) changed.push({ node, facet, changed: verdict.changed });
			if (verdict.outcome === 'converged') converged.push(row);
			else if (verdict.outcome === 'deferred') deferred.push(row);
			else unconverged.push(row);
			log(
				`${verdict.outcome.padEnd(11)} ${node} ${facet}: ${item.before} — ${verdict.changed}` +
					(verdict.why ? ` (${verdict.why})` : '')
			);
		}
	}

	if (DRY_RUN) {
		for (const r of plan.repair) log(`would repair ${r.node} ${r.facet}: ${r.before}`);
	}
	for (const u of unreadable) log(`unreadable  ${u.node} ${u.facet}: ${u.why}`);
	if (!plan.repair.length && !unreadable.length)
		log('✓ no standing runner has drifted throttle env or slice placement.');

	const ok = unconverged.length === 0 && unreadable.length === 0;
	if (!emitter.json) {
		process.exitCode = ok ? 0 : 1;
		return;
	}
	emitter.emit({
		ok,
		dryRun: DRY_RUN,
		planned: plan.repair,
		converged,
		deferred,
		unconverged,
		unreadable,
		changed,
	});
	process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
	console.error(`converge-provisioning: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
