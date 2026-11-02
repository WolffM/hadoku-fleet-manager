/**
 * reconcile-job-reserves — `jobP95Mb` per covered repo, read off the nodes'
 * job-metrics files.
 *
 * Moved out of `reconcile-fleet-runners.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * WAVE 3g J2. Admission reserved one hand-set number per NODE; the axis is
 * the REPO (see `deriveJobReserves`), so the figure lives beside the other
 * per-repo facets and `ephemeral-tick.ts` reads it for the queued run's repo.
 *
 * Every node is read, the backstop included: its jobs run in minted units,
 * whose rows are per-job costs like a claw's.
 *
 * "I COULD NOT LOOK" FAILS. A claw whose file cannot be read would leave its
 * jobs out of every repo's p95 — a partial fleet written as the whole one —
 * so any unreadable node returns `unreadable` with its class and reason, and
 * the caller refuses. A node with NO file is a node that has run no hooked
 * job — `readOutcome` calls that `ok` with zero rows, an empty contribution.
 *
 * `previousByRepo` is the COMMITTED roster's own `jobP95Mb` map, read by the
 * caller before this derivation runs — it is what lets a repo under the
 * min-runs floor keep its last measured reserve instead of the fleet p95
 * (#88). See `deriveJobReserves` for the carry-forward rule.
 */

import { runOnSync, selectMachines } from './fleet-exec.mjs';
import { deriveJobReserves } from './demand-derive.mjs';
import { metricsReadScript, metricsSince, perJobCosts, readOutcome } from './job-metrics.mjs';
import { RETENTION_DAYS } from '../../dist/job-history-store.js';

/**
 * @param {object} manifest
 * @param {string[]} repos
 * @param {object} [previousByRepo]
 */
export function readJobReserves(manifest, repos, previousByRepo = {}) {
	const nodes = selectMachines(manifest);
	const nowMs = Date.now();
	// The SAME read `fleet job-metrics` makes: the window filtered node-side,
	// the rotated `.1` included, and a read that did not finish classed as a
	// read-error rather than returned as a short file. A second spelling of the
	// read here would miss the next rotation change the first one gets.
	const readScript = metricsReadScript(metricsSince(nowMs, RETENTION_DAYS));
	const rows = [];
	const unreadable = [];
	for (const [node] of nodes) {
		const read = readOutcome(node, runOnSync(node, readScript, { as: 'ci', timeoutMs: 60_000 }));
		if (read.read !== 'ok') {
			unreadable.push({
				node,
				why: `${read.read}${read.errno ? ` ${read.errno}` : ''}: ${read.why}`,
			});
			continue;
		}
		// The loop's node, not the row's own hostname — same rule as
		// `collect-job-metrics.mjs`: a row cannot be attributed to a box it did
		// not come from.
		for (const r of read.rows) rows.push({ ...r, node });
	}
	const derived = deriveJobReserves(perJobCosts(rows).rows, {
		repos,
		nowMs,
		windowDays: RETENTION_DAYS,
		previousByRepo,
	});
	return { ...derived, nodesRead: nodes.length - unreadable.length, unreadable };
}
