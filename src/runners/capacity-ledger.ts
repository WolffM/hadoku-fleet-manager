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

/** Older than this, the ledger no longer describes the node: dispatch runs every 15 s. */
export const LEDGER_FRESH_MS = 2 * 60_000;

/**
 * A node's admission input, charged the way the DISPATCHER charged it.
 *
 * The generic verdict (`ephemeral-tick.ts`, shown as `admissionRefusal` in
 * GET /fleet and in `fleet traffic`) is built from the raw probe: every
 * Runner.Worker in `standingBusy`, the held warm listener's busy worker
 * included, against a budget that has ALREADY had that listener's slot taken
 * out. That is the 2026-10-21 double count, fixed in dispatch-pass and never in
 * the display path. Measured 2026-10-25 across three samples: claw-1 shown
 * `at capacity: 2/2` while the dispatcher charged it 1/2, claw-9 `3/3` against
 * 2/3, and every other node's numbers one too high.
 *
 * Subtracting the held slot here is NOT the fix: an idle listener has no worker
 * to subtract, and only dispatch-pass knows the live JIT units that make the
 * correction exact. So the dispatcher's own last charge is substituted while it
 * is fresh, and `admitMint` is re-run on it, so a memory or space clause
 * behind the concurrency one is still evaluated. No fresh entry: unchanged.
 */
export function chargedLikeDispatch<
	T extends { liveUnits: number; standingBusy: number; maxConcurrent: number },
>(name: string, ns: T, l: CapacityLedger | null, nowMs: number = Date.now()): T {
	if (!l || nowMs - Date.parse(l.at) > LEDGER_FRESH_MS) return ns;
	const e = l.nodes.find((x) => x.node === name);
	if (!e) return ns;
	return { ...ns, liveUnits: e.liveUnits, standingBusy: e.standingBusy, maxConcurrent: e.budget };
}

export function __resetCapacityLedgerForTesting(): void {
	ledger = null;
}
