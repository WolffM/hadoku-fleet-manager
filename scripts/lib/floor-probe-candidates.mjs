import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCiDemandRow } from './floor-probe.mjs';
import { readDrains } from './expected-down.mjs';
import { stateDir } from './paths.mjs';

/** Drain state, read from where the DISPATCHER reads it — not a git checkout. */
export function drainedNodes() {
	// A parse failure THROWS in drain.ts and every caller fails closed. Same here:
	// answering "nothing is drained" would place a probe on a box somebody is
	// holding a screwdriver over.
	return Object.keys(readDrains());
}

/**
 * What a `(repo, job)` demands, unioned across every CI demand-ledger record.
 *
 * FILTERED ON `class`, and that filter is load-bearing rather than defensive.
 * The ledger holds resident workloads — PM2 services, cron jobs, deployment
 * checkouts — in the SAME file as CI jobs as of Wave 3-prep, by decision, and a
 * resident row shares the `(repo, job)` shape. Unioned in, a PM2 service's
 * capabilities become a CI job's requirements and every claw that cannot satisfy
 * them is excluded with reason `capability` — a candidate list of zero for a job
 * the fleet serves all day, and this time wearing a certainty. `isCiDemandRow`
 * owns the rule because a predicate inside a script that ssh's to six boxes
 * cannot be exercised.
 */
export function demandFor(repo, job) {
	const p = join(stateDir(), 'demand-ledger.jsonl');
	if (!existsSync(p)) return null; // could not look — the caller decides
	const caps = new Set();
	let seen = false;
	for (const line of readFileSync(p, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isCiDemandRow(r, { repo, job })) continue;
		seen = true;
		// A capability once demanded does not un-demand itself between ledger runs.
		for (const c of r.capabilities ?? []) caps.add(c);
	}
	return seen ? caps : null;
}
