/**
 * label-floor-persist — writes the static half of the demand for the
 * runtime floor to read, then reads it back exactly as runner-health would,
 * to compute what the runtime floor actually watches and what a demanded
 * label is missing from it.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.mjs';
import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { FLOOR_DEMAND_FILE, floorLabels } from '../../dist/label-floor.js';

/**
 * THE STATIC HALF OF THE DEMAND, PERSISTED FOR THE RUNTIME FLOOR.
 *
 * runner-health watches what jobs ACTUALLY requested (it holds job history
 * in-process) unioned with this file, because it cannot read every covered
 * repo's workflows itself. Without the file a label only a rarely-run workflow
 * asks for — `cargo-bevy`, zero observed jobs in the 14 days to 2026-10-10 —
 * would be unwatched, and a job that queues forever never STARTS, so it never
 * reaches job history either.
 *
 * WRITTEN ONLY FROM A COMPLETE READ. A partial static read (a missing
 * checkout, a workflows directory gone, a `runs-on` the reader cannot resolve)
 * would REPLACE a complete file with a shorter one and silently unwatch labels;
 * those cases fail the gate on the caller's side, and the previous file stays
 * in place.
 *
 * HISTORICAL DEMAND: a label nothing offers that only past JOBS asked for.
 *
 * The caller keeps an unoffered label in the dependency set so the gate never
 * gets easier to pass as capabilities disappear. The reverse case is a label
 * nothing ASKS for any more: hadoku-watchparty moved ingest off
 * `watchparty-media` (e87161e6, 2026-10-28) and bootcamp revoked it the same
 * day, and the jobs that ran on it before stayed in the observed window for
 * fourteen days, failing this gate on a dependency no workflow has
 * (fleet-manager#29).
 *
 * Only a COMPLETE static read can say "no workflow asks". Every covered
 * repo's shipped workflows were read and every `runs-on` resolved, so a label
 * with no static job is not a live dependency of any of them. It is reported
 * with when it was last asked for, and it ages out of the window on its own.
 * An incomplete read keeps it failing: then the gate cannot tell. And a job
 * that asks for an unoffered label never starts, so it never reaches job
 * history: a live runtime-resolved ask shows up in ci:queue-health, not here.
 *
 * @param {{demandSources: object, nothingOffers: string[], coveredRepos: string[],
 *   unread: string[], noWorkflows: string[], unresolvable: string[],
 *   observed: {labels: Map<string,number>}|null, dependencies: string[]}} demand
 */
export function persistAndWatchDemand({
	demandSources,
	nothingOffers,
	coveredRepos,
	unread,
	noWorkflows,
	unresolvable,
	observed,
	dependencies,
}) {
	const floorDemandPath = join(stateDir(), FLOOR_DEMAND_FILE);
	const staticDemand = Object.entries(demandSources)
		.filter(([, src]) => src.static.length > 0)
		.map(([l]) => l)
		.sort();
	const staticComplete =
		coveredRepos.length > 0 && !unread.length && !noWorkflows.length && !unresolvable.length;

	const historical = staticComplete
		? nothingOffers.filter((l) => demandSources[l].static.length === 0)
		: [];
	const unoffered = nothingOffers.filter((l) => !historical.includes(l));
	let floorDemandWriteError = null;
	if (staticComplete) {
		try {
			// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
			writeFileAtomic(
				floorDemandPath,
				`${JSON.stringify({ at: new Date().toISOString(), labels: staticDemand }, null, 2)}\n`
			);
		} catch (err) {
			// Reported, never swallowed: the runtime floor would keep reading the
			// previous file, or none.
			floorDemandWriteError = String(err.message ?? err);
			console.error(
				`! could not persist the static floor demand to ${floorDemandPath}: ${floorDemandWriteError}`
			);
		}
	}

	/**
	 * What the RUNTIME floor will watch, read back exactly as runner-health reads
	 * it: observed demand ∪ the persisted static file — the file ON DISK, not the
	 * set this run computed, so a write that failed is a write that did not happen.
	 */
	let persistedStatic = [];
	let persistedStaticError = null;
	try {
		const parsed = JSON.parse(readFileSync(floorDemandPath, 'utf8'));
		if (!Array.isArray(parsed.labels)) throw new Error('it carries no `labels` array');
		persistedStatic = parsed.labels.filter((l) => typeof l === 'string');
	} catch (err) {
		persistedStaticError = err.code === 'ENOENT' ? 'no such file' : String(err.message ?? err);
	}
	const runtimeWatched = new Set(
		floorLabels([...(observed?.labels.keys() ?? []), ...persistedStatic])
	);

	/**
	 * A demanded label the RUNTIME floor will not watch. With one rule for every
	 * label this is no longer "outside a list" — it is a label only the static
	 * read found, whose persisted copy is missing or out of date, so runner-health
	 * cannot see it and the last runner offering it can go dark unannounced.
	 */
	const missing = dependencies.filter((l) => !runtimeWatched.has(l) && !unoffered.includes(l));

	return {
		FLOOR_DEMAND_PATH: floorDemandPath,
		staticDemand,
		staticComplete,
		historical,
		unoffered,
		floorDemandWriteError,
		persistedStatic,
		persistedStaticError,
		runtimeWatched,
		missing,
	};
}
