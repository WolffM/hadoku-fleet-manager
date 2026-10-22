/**
 * CAPACITY LEDGER — what the dispatcher charged each node this pass, beside
 * what it could see, with one invariant between them.
 *
 * WHY IT EXISTS. From 2026-10-07 to 2026-10-21 `admitMint`'s in-flight count
 * was `liveUnits + standingBusy` where `standingBusy` was the probe's count of
 * EVERY Runner.Worker on the box — a running JIT unit's own worker included.
 * Every JIT job was charged twice, the fleet ran at about half its slots, and
 * nothing said so: the panel counted registrations, `fleet traffic` said
 * "admitted", and the only number that was wrong lived inside a log sentence.
 * Both halves had correct unit tests; the bug was in the seam.
 *
 * THE INVARIANT. A node may never be charged more jobs than it is observably
 * running or starting:
 *
 *     inFlight <= max(liveUnits, probeWorkers)
 *
 * `liveUnits` is the JIT units listed on the node (running or still
 * registering); `probeWorkers` is every Runner.Worker the probe counted (JIT,
 * warm and standing jobs, all actually running). Correct accounting sits
 * under the larger of the two in every shape the fleet has — a JIT job counts
 * in both, a starting unit only in the first, a standing or warm job only in
 * the second. The double count breaks it the moment one JIT job runs: charged
 * 2 against max(1, 1). `inFlight >= liveUnits` closes the other side — a unit
 * on the node is never charged less than once.
 *
 * TWO READERS. runner-health pages when a node breaks the invariant for
 * several consecutive ticks (one broken pass is a race between the unit
 * listing and the probe; three ticks is a bug). `GET /fleet` carries the
 * entries so the panel can print the dispatcher's own `in flight a/b` beside
 * runner-health's `busy n/max` — two different questions that were shown as
 * one.
 *
 * IN-MEMORY, like the affinity counters next door: it is a statement about
 * the last pass this process ran, and a restarted process has run none.
 */

export interface CapacityEntry {
	node: string;
	/** JIT units listed on the node this pass, running or registering. */
	liveUnits: number;
	/** Every Runner.Worker the fleet probe counted on the node, pre-correction. */
	probeWorkers: number;
	/** Standing jobs charged after the JIT and held-warm workers were taken back out. */
	standingBusy: number;
	/** Warm listeners the node holds a slot for (already out of `budget`). */
	warmHeld: number;
	/** What the dispatcher may run here: maxConcurrent less the held listeners. */
	budget: number;
	/** What admission charged: `liveUnits + standingBusy`. */
	inFlight: number;
	ok: boolean;
	/** The broken clause, or null when `ok`. */
	why: string | null;
}

export type CapacityLedger = { at: string; nodes: CapacityEntry[] };

/** The invariant, on its own so a test can hand it the 2026-10-07 numbers. */
export function judgeCapacity(
	e: Omit<CapacityEntry, 'ok' | 'why'>
): { ok: true; why: null } | { ok: false; why: string } {
	const ceiling = Math.max(e.liveUnits, e.probeWorkers);
	if (e.inFlight > ceiling) {
		return {
			ok: false,
			why:
				`charged ${e.inFlight} in flight against ${e.liveUnits} JIT unit(s) and ` +
				`${e.probeWorkers} running worker(s) — a node cannot be running more than ` +
				`max(units, workers)=${ceiling}; something is counted twice`,
		};
	}
	if (e.inFlight < e.liveUnits) {
		return {
			ok: false,
			why: `charged ${e.inFlight} in flight with ${e.liveUnits} JIT unit(s) listed — a unit is counted less than once`,
		};
	}
	return { ok: true, why: null };
}

let ledger: CapacityLedger | null = null;

/** Replace the ledger wholesale — one pass, one truth. */
export function recordCapacityLedger(
	entries: readonly Omit<CapacityEntry, 'ok' | 'why'>[],
	nowMs: number = Date.now()
): CapacityLedger {
	ledger = {
		at: new Date(nowMs).toISOString(),
		nodes: entries.map((e) => ({ ...e, ...judgeCapacity(e) })),
	};
	return ledger;
}

/** The last pass's ledger, or null when this process has run no pass. */
export function getCapacityLedger(): CapacityLedger | null {
	return ledger;
}

export function __resetCapacityLedgerForTesting(): void {
	ledger = null;
}
