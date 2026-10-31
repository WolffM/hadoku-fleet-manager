import { logger, stateDir } from '../host.js';
import { writeFileAtomic } from '../lib/atomic-json.js';
import { join } from 'node:path';

/**
 * Stuck runs already warned about.
 *
 * A stuck run stays stuck — that is what makes it stuck — so warning every tick
 * turns a real finding into 6 lines an hour, forever, and the fleet's own logs
 * become the thing nobody reads.
 *
 * THE TWO ZOMBIES CANNOT BE CLEARED AT ALL — not "until someone gets to it".
 * Tested to exhaustion on 2026-09-07, by API and by a human in the web UI.
 *
 * The REST API is CONSISTENT, and an earlier version of this comment got that
 * wrong by listing four "contradictory" answers. Two of those were client
 * renderings — the `gh` CLI says "is completed", the web UI says "is not in
 * progress" — and quoting them as server states overstated the evidence. The
 * server says one thing:
 *
 *   POST /cancel        -> 409 "Cannot cancel a workflow run that has not been queued yet."
 *   POST /force-cancel  -> 409 (identical)
 *   DELETE /runs/<id>   -> 403 "Could not delete the workflow run"
 *
 * The real contradiction is smaller and much sharper, and it is between two
 * endpoints of the same API for the same run:
 *
 *   GET  /runs/<id>     -> "status": "queued"
 *   POST /runs/<id>/cancel -> "has not been queued yet"
 *
 * Both cannot be true. And the two refusals close the loop on each other: it
 * cannot be cancelled because the cancel endpoint says it was never queued, and
 * it cannot be deleted because DELETE wants a COMPLETED run. There is no
 * transition out.
 *
 * The 403 is a STATE refusal rather than a scope one: retried with the
 * owner's own credential, same answer.
 *
 * The cause is visible in the runs themselves — both report `total_count: 0`
 * jobs. A run that never produced a job was never queued in the sense the
 * cancel endpoint means, so no state transition it offers applies, and the
 * record is stranded server-side. That is also why minting for them could never
 * have helped: there is no job to assign.
 *
 * Note this is NOT the same as a genuinely queued run that will not cancel.
 * hadoku-jobplatform#34076512658 refused a plain cancel on 2026-09-07 and
 * force-cancel cleared it in one call — it had real jobs. Reach for
 * force-cancel there; it is not the answer here.
 *
 * So they stay until GitHub Support removes them. `summariseQueue` already
 * contains the cost: they are classified `zombie` and reported rather than
 * failed, so they cannot pin the gate red.
 *
 * ---------------------------------------------------------------------------
 * AND THE SET IS A FILE, BECAUSE THE PROCESS IS NOT DURABLE (issue #25).
 * ---------------------------------------------------------------------------
 *
 * "Said ONCE per run" was true of one PROCESS and of nothing else, and that is
 * not what an operator reading the logs experiences. mgmt-api restarts on every
 * deploy — 28 in one morning is on record — and each restart handed this set
 * back empty, so the same ids were announced again. Counted in
 * `~/.pm2/logs/mgmt-api-out__*.log`, the line about the same two permanent
 * zombies appeared 32 times on 2026-09-08 and 23 on 2026-09-09. The in-process
 * dedup was working perfectly the whole time; it was simply scoped to the wrong
 * lifetime.
 *
 * So the announcement is booked in `STUCK_ANNOUNCED_FILE` under `stateDir()`,
 * which outlives the process. Three properties this has to keep:
 *
 *  1. IT NEVER GETS QUIETER AS THE FAILURE GETS WORSE. Suppression is keyed on
 *     the RUN ID, so a new unclearable run is a new key and is announced even
 *     while a dozen old ones are suppressed; and every line carries the TOTAL
 *     alongside the new ones, so a growing population is visible in the one
 *     line it does emit. (The key is the full `repo#id` STRING — it was a
 *     32-bit hash, which at this file's new lifetime and size is a way for a
 *     genuinely new run to be silenced by a collision nobody could ever
 *     diagnose.)
 *  2. IT NEVER RETRACTS THE FINDING. The runs stay in `stuckRuns` and stay
 *     classified `zombie`; `ci:queue-health` counts them on every run, every
 *     run, regardless of what this file says. What is suppressed is a repeated
 *     LINE, never the count.
 *  3. "I COULD NOT LOOK" DOES NOT PRUNE. An entry is dropped only when its
 *     repo's listing was READ on this tick and the run was absent from it — so
 *     an API failure leaves the book untouched rather than forgetting six
 *     zombies and re-announcing them the moment it recovers.
 */
export const STUCK_ANNOUNCED_FILE = 'dispatch-stuck-announced.json';

/**
 * Ceiling on the announced set, because a persisted file grows where a process
 * one could not.
 *
 * The prune above handles every run that leaves a queue this dispatcher still
 * polls. It cannot handle a repo that leaves the ROSTER while holding a zombie:
 * nothing polls it again, so its entries are never observed gone. That leaks
 * slowly — six ids in a month of the worst incident on record — and a cap of 500
 * is far past any honest population.
 *
 * DROPS THE OLDEST, and says so. Dropping the newest would silence exactly the
 * findings this mechanism exists to surface; dropping the oldest re-announces a
 * long-known zombie once, which is noise rather than a lost signal.
 */
export const MAX_ANNOUNCED_STUCK = 500;

/** `repo#id` -> the ISO time it was first announced. Loaded lazily from disk. */
export const warnedStuck = new Map<string, string>();

/** Store failures are announced once per process, never once per tick. */
export const stuckStoreComplaints = new Set<string>();

export const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function complainOnce(key: string, message: string): void {
	if (stuckStoreComplaints.has(key)) return;
	stuckStoreComplaints.add(key);
	logger.warn(`[dispatch-tick] ${message}`);
}

export const stuckStorePath = (): string => join(stateDir(), STUCK_ANNOUNCED_FILE);

/** Oldest-first, so the cap and the prune both have one ordering to agree on. */
export function capAnnouncedStuck(): void {
	if (warnedStuck.size <= MAX_ANNOUNCED_STUCK) return;
	const oldestFirst = [...warnedStuck.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	const drop = oldestFirst.slice(0, warnedStuck.size - MAX_ANNOUNCED_STUCK);
	for (const [k] of drop) warnedStuck.delete(k);
	complainOnce(
		'cap',
		`the announced-stuck book passed ${MAX_ANNOUNCED_STUCK} entries — dropped the ` +
			`${drop.length} oldest, which WILL be announced again: ${drop
				.slice(0, 5)
				.map(([k]) => k)
				.join(', ')}. A book this size means runs are being written off faster than ` +
			`they leave the queue; that is the finding, not this line.`
	);
}

/**
 * Write the book back. ONLY when it changed — this is on the 15 s dispatch tick,
 * and a steady fleet must not write a file 240 times an hour to say nothing.
 *
 * Temp-and-rename, so a torn write cannot leave a half-object behind; the parse
 * failure that would follow is survivable but costs a duplicated announcement of
 * every zombie on the fleet.
 */
export function persistWarnedStuck(): void {
	capAnnouncedStuck();
	const path = stuckStorePath();
	try {
		// Write-then-rename (F3, `lib/atomic-json.ts`), fsync SKIPPED — a RECORDED
		// divergence (plan §4.1 step 2): this is the 15 s dispatch tick, named
		// explicitly in the wave brief as a site where the two extra fsyncs are
		// not worth paying. A lost write here costs one re-announced zombie, not
		// a lost decision.
		writeFileAtomic(path, `${JSON.stringify(Object.fromEntries(warnedStuck), null, '\t')}\n`, {
			fsync: false,
		});
	} catch (e) {
		// SAY WHY, and say what it costs. A silent persist failure is invisibly
		// identical to the bug this file was written to close.
		complainOnce(
			'write',
			`could not persist ${path}: ${reasonOf(e)} — every stuck run will be announced ` +
				`again on the next restart, which is issue #25 back`
		);
	}
}

/** `WolffM/hadoku_site#34749048183` -> `WolffM/hadoku_site`. */
export function repoOfStuckKey(key: string): string {
	const i = key.lastIndexOf('#');
	return i === -1 ? key : key.slice(0, i);
}
